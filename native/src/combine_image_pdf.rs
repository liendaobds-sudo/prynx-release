//! Fast path Combine cho manifest chỉ gồm PNG/JPEG.
//!
//! PERF (audit 2026-08-02 §TC.1): tránh UPNG/pako trong WebView và tránh
//! ReportLab tạo PDF tạm từng ảnh. Module này không gọi PDFium.

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::ImageFormat;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
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

#[derive(Debug)]
enum ImagePdfError {
    Invalid(String),
    Unsupported(String),
    Cancelled,
    Io(String),
    Runtime(String),
}

impl fmt::Display for ImagePdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message)
            | Self::Unsupported(message)
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

#[derive(Debug)]
enum AssetFilter {
    Flate { colors: i64 },
    Dct,
}

#[derive(Debug)]
struct CompressedAlpha {
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
    has_iccp: bool,
    has_animation: bool,
    idat: Vec<u8>,
}

#[derive(Debug)]
struct ParsedJpeg {
    width: u32,
    height: u32,
    bits_per_component: i64,
    channels: u8,
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

    let mut assets: Vec<Option<PreparedAsset>> = (0..request.sources.len()).map(|_| None).collect();
    for (source_index, asset) in prepared_pairs {
        assets[source_index] = Some(asset);
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
) -> Result<Vec<(usize, PreparedAsset)>, ImagePdfError> {
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
) -> Result<PreparedAsset, ImagePdfError> {
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
        "png" => prepare_png(&bytes, source),
        "jpg" | "jpeg" => prepare_jpeg(&bytes, source),
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

fn prepare_png(bytes: &[u8], source: &ImageSourceSpec) -> Result<PreparedAsset, ImagePdfError> {
    let parsed = parse_png(bytes)?;
    ensure_pixel_parity(parsed.width, parsed.height, source)?;
    if parsed.has_animation {
        return Err(ImagePdfError::Unsupported(
            "APNG nhiều frame không thuộc fast path".to_string(),
        ));
    }
    if parsed.has_iccp {
        return Err(ImagePdfError::Unsupported(
            "PNG có ICC cần đường giữ màu đã audit riêng".to_string(),
        ));
    }

    if parsed.bit_depth == 8
        && parsed.interlace == 0
        && !parsed.has_trns
        && matches!(parsed.color_type, 0 | 2)
    {
        let (color_space, colors) = if parsed.color_type == 0 {
            (AssetColorSpace::Gray, 1)
        } else {
            (AssetColorSpace::Rgb, 3)
        };
        return Ok(PreparedAsset {
            width_px: parsed.width,
            height_px: parsed.height,
            bits_per_component: 8,
            color_space,
            filter: AssetFilter::Flate { colors },
            data: parsed.idat,
            alpha: None,
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
    let rgba = decoded.to_rgba8().into_raw();
    let pixel_count = (source.width_px as usize)
        .checked_mul(source.height_px as usize)
        .ok_or_else(|| ImagePdfError::Invalid("Kích thước PNG bị tràn số".to_string()))?;
    let has_alpha = rgba.chunks_exact(4).any(|pixel| pixel[3] != 255);
    let mut rgb = Vec::with_capacity(pixel_count * 3);
    let mut alpha = has_alpha.then(|| Vec::with_capacity(pixel_count));
    for pixel in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
        if let Some(channel) = alpha.as_mut() {
            channel.push(pixel[3]);
        }
    }

    Ok(PreparedAsset {
        width_px: source.width_px,
        height_px: source.height_px,
        bits_per_component: 8,
        color_space: AssetColorSpace::Rgb,
        filter: AssetFilter::Flate { colors: 3 },
        data: compress_predictor_rows(&rgb, source.width_px, source.height_px, 3)?,
        alpha: alpha
            .map(|channel| compress_predictor_rows(&channel, source.width_px, source.height_px, 1))
            .transpose()?
            .map(|data| CompressedAlpha { data }),
        invert_cmyk: false,
    })
}

fn parse_png(bytes: &[u8]) -> Result<ParsedPng, ImagePdfError> {
    if bytes.len() < PNG_SIGNATURE.len() || &bytes[..8] != PNG_SIGNATURE {
        return Err(ImagePdfError::Invalid("Sai signature PNG".to_string()));
    }

    let mut cursor = 8usize;
    let mut ihdr: Option<(u32, u32, u8, u8, u8)> = None;
    let mut idat = Vec::new();
    let mut has_trns = false;
    let mut has_iccp = false;
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
                if width == 0 || height == 0 || compression != 0 || filter != 0 || interlace > 1 {
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
            b"iCCP" => has_iccp = true,
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
    Ok(ParsedPng {
        width,
        height,
        bit_depth,
        color_type,
        interlace,
        has_trns,
        has_iccp,
        has_animation,
        idat,
    })
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
    Ok(PreparedAsset {
        width_px: parsed.width,
        height_px: parsed.height,
        bits_per_component: parsed.bits_per_component,
        color_space,
        filter: AssetFilter::Dct,
        data: bytes.to_vec(),
        alpha: None,
        invert_cmyk,
    })
}

fn parse_jpeg(bytes: &[u8]) -> Result<ParsedJpeg, ImagePdfError> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return Err(ImagePdfError::Invalid("Sai signature JPEG".to_string()));
    }
    let mut cursor = 2usize;
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
            let payload = cursor + 2;
            let bits_per_component = bytes[payload] as i64;
            let height = u16::from_be_bytes([bytes[payload + 1], bytes[payload + 2]]) as u32;
            let width = u16::from_be_bytes([bytes[payload + 3], bytes[payload + 4]]) as u32;
            let channels = bytes[payload + 5];
            if width == 0 || height == 0 || bits_per_component <= 0 {
                return Err(ImagePdfError::Invalid("SOF JPEG không hợp lệ".to_string()));
            }
            return Ok(ParsedJpeg {
                width,
                height,
                bits_per_component,
                channels,
            });
        }
        cursor += length;
    }
    Err(ImagePdfError::Invalid(
        "JPEG không có marker SOF hợp lệ".to_string(),
    ))
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
) -> Result<Vec<u8>, ImagePdfError> {
    let row_bytes = (width as usize)
        .checked_mul(channels)
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
            let left = if index >= channels {
                row[index - channels]
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
    assets: Vec<Option<PreparedAsset>>,
    hooks: &CallbackHooks,
) -> Result<Document, ImagePdfError> {
    let mut document = Document::with_version("1.7");
    let mut image_ids: Vec<Option<ObjectId>> = (0..request.sources.len()).map(|_| None).collect();

    for (source_index, asset) in assets.into_iter().enumerate() {
        let Some(asset) = asset else {
            continue;
        };
        hooks.check_cancelled()?;
        image_ids[source_index] = Some(add_image_object(&mut document, asset));
    }

    let pages_id = document.new_object_id();
    let mut kids = Vec::with_capacity(request.pages.len());
    let mut first_visible_size: Option<(f64, f64)> = None;

    for page in &request.pages {
        hooks.check_cancelled()?;
        let rotation = normalize_rotation(page.rotation)?;
        let (width_pt, height_pt, image_id) = if page.blank {
            let size = if page.width.is_some() || page.height.is_some() {
                (
                    page.width.unwrap_or(A4_WIDTH_PT),
                    page.height.unwrap_or(A4_HEIGHT_PT),
                )
            } else {
                first_visible_size.unwrap_or((A4_WIDTH_PT, A4_HEIGHT_PT))
            };
            (size.0, size.1, None)
        } else {
            let source_index = page.file_index.expect("đã validate file_index");
            let source = &request.sources[source_index];
            (
                source.width_pt,
                source.height_pt,
                Some(image_ids[source_index].ok_or_else(|| {
                    ImagePdfError::Runtime("Nguồn ảnh chưa được chuẩn bị".to_string())
                })?),
            )
        };

        let content = image_id
            .map(|_| {
                format!("q\n{width_pt:.6} 0 0 {height_pt:.6} 0 0 cm\n/Im0 Do\nQ\n").into_bytes()
            })
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
        let page_id = document.add_object(page_dictionary);
        kids.push(Object::Reference(page_id));

        if first_visible_size.is_none() {
            first_visible_size = Some(if matches!(rotation, 90 | 270) {
                (height_pt, width_pt)
            } else {
                (width_pt, height_pt)
            });
        }
    }

    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => request.pages.len() as i64,
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

fn add_image_object(document: &mut Document, asset: PreparedAsset) -> ObjectId {
    let alpha_id = asset.alpha.map(|alpha| {
        let mut alpha_dictionary =
            base_image_dictionary(asset.width_px, asset.height_px, 8, AssetColorSpace::Gray);
        alpha_dictionary.set("Filter", "FlateDecode");
        alpha_dictionary.set("DecodeParms", predictor_dictionary(asset.width_px, 1, 8));
        document.add_object(Stream::new(alpha_dictionary, alpha.data))
    });

    let mut image_dictionary = base_image_dictionary(
        asset.width_px,
        asset.height_px,
        asset.bits_per_component,
        asset.color_space,
    );
    match asset.filter {
        AssetFilter::Flate { colors } => {
            image_dictionary.set("Filter", "FlateDecode");
            image_dictionary.set(
                "DecodeParms",
                predictor_dictionary(asset.width_px, colors, asset.bits_per_component),
            );
        }
        AssetFilter::Dct => {
            image_dictionary.set("Filter", "DCTDecode");
        }
    }
    if let Some(alpha_id) = alpha_id {
        image_dictionary.set("SMask", Object::Reference(alpha_id));
    }
    if asset.invert_cmyk {
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
    document.add_object(Stream::new(image_dictionary, asset.data))
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
        "ColorSpace" => match color_space {
            AssetColorSpace::Gray => Object::Name(b"DeviceGray".to_vec()),
            AssetColorSpace::Rgb => Object::Name(b"DeviceRGB".to_vec()),
            AssetColorSpace::Cmyk => Object::Name(b"DeviceCMYK".to_vec()),
        },
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

    fn source(path: &Path, width: u32, height: u32) -> ImageSourceSpec {
        ImageSourceSpec {
            path: path.to_string_lossy().into_owned(),
            width_px: width,
            height_px: height,
            width_pt: width as f64,
            height_pt: height as f64,
        }
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
