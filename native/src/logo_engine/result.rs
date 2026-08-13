//! Kết quả có cấu trúc tại biên ABI của PrynX Logo Engine v2.

use super::color::{nearest_palette_index, parse_palette};
use super::profiles::{trace_core_profile, CoreProfileOptions};
use super::qc::{inspect_svg_artifact_cancellable, ArtifactQcOptions};
use super::request::{LogoEngineProfile, LogoEngineRequest};
use super::scene::EngineProvenance;
use super::svg_writer::{write_svg, PhysicalSizeMm, SvgWriteOptions};

pub(crate) const LOGO_STRUCTURED_RESULT_VERSION: u16 = 1;
const MAX_CORE_PALETTE_COLORS: usize = 13;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct StructuredResultOptions {
    pub(crate) background_label: Option<u16>,
    pub(crate) physical_size_mm: Option<PhysicalSizeMm>,
    pub(crate) raster_scale: u32,
    /// Ngân sách do backend/scheduler cấp; None không hard-cap máy mạnh.
    pub(crate) max_output_bytes: Option<usize>,
    pub(crate) max_raster_pixels: Option<usize>,
    pub(crate) min_iou: Option<f64>,
    pub(crate) max_mae: Option<f64>,
}

impl Default for StructuredResultOptions {
    fn default() -> Self {
        Self {
            background_label: None,
            physical_size_mm: None,
            raster_scale: 4,
            max_output_bytes: None,
            max_raster_pixels: None,
            min_iou: None,
            max_mae: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StructuredResultMetrics {
    pub(crate) layer_count: usize,
    pub(crate) component_count: usize,
    pub(crate) outer_count: usize,
    pub(crate) hole_count: usize,
    pub(crate) source_nodes: usize,
    pub(crate) output_nodes: usize,
    pub(crate) max_error_px: f64,
    pub(crate) raster_scale: u32,
    pub(crate) iou: f64,
    pub(crate) mae: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LogoStructuredResult {
    pub(crate) schema_version: u16,
    pub(crate) scene_version: u16,
    pub(crate) svg: String,
    pub(crate) artifact_sha256: String,
    pub(crate) artifact_byte_len: usize,
    pub(crate) width_px: u32,
    pub(crate) height_px: u32,
    pub(crate) physical_size_mm: Option<PhysicalSizeMm>,
    pub(crate) coordinate_system: &'static str,
    pub(crate) provenance: EngineProvenance,
    pub(crate) preprocess_hash: String,
    pub(crate) metrics: StructuredResultMetrics,
    pub(crate) warnings: Vec<String>,
}

pub(crate) fn build_structured_result(
    request: &LogoEngineRequest,
    options: StructuredResultOptions,
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<LogoStructuredResult, String> {
    validate_structured_request(request, options.background_label)?;
    ensure_not_cancelled(is_cancelled)?;
    let profile_output = trace_core_profile(
        request,
        CoreProfileOptions {
            background_label: options.background_label,
        },
    )?;
    ensure_not_cancelled(is_cancelled)?;

    let artifact = write_svg(
        &profile_output.scene,
        SvgWriteOptions {
            physical_size_mm: options.physical_size_mm,
            max_output_bytes: options.max_output_bytes,
        },
    )?;
    ensure_not_cancelled(is_cancelled)?;

    let reference_rgba = build_qc_reference(request, options.background_label)?;
    let qc = inspect_svg_artifact_cancellable(
        &artifact.svg,
        &profile_output.scene,
        Some(&reference_rgba),
        ArtifactQcOptions {
            expected_physical_size_mm: options.physical_size_mm,
            raster_scale: options.raster_scale,
            max_input_bytes: options.max_output_bytes,
            max_raster_pixels: options.max_raster_pixels,
            min_iou: options.min_iou,
            max_mae: options.max_mae,
        },
        is_cancelled,
    )?;
    ensure_not_cancelled(is_cancelled)?;

    if artifact.sha256 != qc.artifact_sha256 || artifact.byte_len != qc.byte_len {
        return Err("Hash hoặc kích thước artifact lệch giữa writer và QC".to_string());
    }
    if profile_output.metrics.outer_count != qc.outer_count
        || profile_output.metrics.hole_count != qc.hole_count
    {
        return Err("Topology metrics lệch giữa profile và QC artifact".to_string());
    }
    let iou = qc
        .iou
        .ok_or_else(|| "QC structured result thiếu IoU".to_string())?;
    let mae = qc
        .mae
        .ok_or_else(|| "QC structured result thiếu MAE".to_string())?;
    let mut warnings = Vec::new();
    if request.despeckle_size_px > 0 && request.profile == LogoEngineProfile::Silhouette {
        warnings.push(format!(
            "Profile đen trắng chưa áp dụng khử hạt {} px; cần kiểm tra kết quả trước khi dùng production.",
            request.despeckle_size_px
        ));
    }

    Ok(LogoStructuredResult {
        schema_version: LOGO_STRUCTURED_RESULT_VERSION,
        scene_version: profile_output.scene.version,
        svg: artifact.svg,
        artifact_sha256: artifact.sha256,
        artifact_byte_len: artifact.byte_len,
        width_px: qc.width_px,
        height_px: qc.height_px,
        physical_size_mm: qc.physical_size_mm,
        coordinate_system: "pixel_top_left",
        provenance: profile_output.scene.provenance,
        preprocess_hash: profile_output.preprocess_hash,
        metrics: StructuredResultMetrics {
            layer_count: profile_output.metrics.layer_count,
            component_count: profile_output.metrics.component_count,
            outer_count: qc.outer_count,
            hole_count: qc.hole_count,
            source_nodes: profile_output.metrics.source_nodes,
            output_nodes: profile_output.metrics.output_nodes,
            max_error_px: profile_output.metrics.max_error_px,
            raster_scale: options.raster_scale,
            iou,
            mae,
        },
        warnings,
    })
}

pub(crate) fn validate_structured_request(
    request: &LogoEngineRequest,
    background_label: Option<u16>,
) -> Result<(), String> {
    if request.width == 0 || request.height == 0 {
        return Err("Ảnh có chiều bằng 0".to_string());
    }
    let expected_len = request
        .width
        .checked_mul(request.height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Kích thước ảnh tràn số".to_string())?;
    if request.rgba.len() != expected_len {
        return Err(format!(
            "Đệm RGBA dài {} byte nhưng {}×{} cần {} byte",
            request.rgba.len(),
            request.width,
            request.height,
            expected_len
        ));
    }
    if request.rgba.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        return Err("Ảnh hoặc vùng đã chọn không có pixel nhìn thấy".to_string());
    }
    if !request.smoothing.is_finite() || !(0.0..=1.0).contains(&request.smoothing) {
        return Err("Độ mượt phải nằm trong khoảng 0 đến 1".to_string());
    }
    match request.profile {
        LogoEngineProfile::Silhouette => {
            if !request.palette.is_empty() {
                return Err("Chế độ đen trắng không nhận palette màu".to_string());
            }
            if background_label.is_some() {
                return Err("Chế độ đen trắng không nhận nhãn background".to_string());
            }
        }
        LogoEngineProfile::FlatColor => {
            if !(1..=MAX_CORE_PALETTE_COLORS).contains(&request.palette.len()) {
                return Err("Chế độ màu cần palette engine gồm 1–13 màu".to_string());
            }
            parse_palette(&request.palette)?;
            if background_label.is_some_and(|label| usize::from(label) >= request.palette.len()) {
                return Err("Nhãn background nằm ngoài palette".to_string());
            }
        }
    }
    Ok(())
}

fn ensure_not_cancelled(is_cancelled: &mut dyn FnMut() -> bool) -> Result<(), String> {
    if is_cancelled() {
        Err("Đã hủy vector hóa logo".to_string())
    } else {
        Ok(())
    }
}

fn build_qc_reference(
    request: &LogoEngineRequest,
    background_label: Option<u16>,
) -> Result<Vec<u8>, String> {
    let palette = match request.profile {
        LogoEngineProfile::Silhouette => parse_palette(&["#000000".to_string()])?,
        LogoEngineProfile::FlatColor => parse_palette(&request.palette)?,
    };
    let expected_len = request
        .width
        .checked_mul(request.height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Kích thước reference QC vượt giới hạn biểu diễn".to_string())?;
    if request.rgba.len() != expected_len {
        return Err("Buffer RGBA không khớp kích thước reference QC".to_string());
    }

    let mut reference = Vec::with_capacity(expected_len);
    for pixel in request.rgba.chunks_exact(4) {
        let alpha = pixel[3];
        if alpha == 0 {
            reference.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        let label = match request.profile {
            LogoEngineProfile::Silhouette => 0,
            LogoEngineProfile::FlatColor => {
                nearest_palette_index([pixel[0], pixel[1], pixel[2]], &palette)
            }
        };
        if background_label == Some(label as u16) {
            reference.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            let paint = palette[label].paint;
            reference.extend_from_slice(&[paint.rgba[0], paint.rgba[1], paint.rgba[2], alpha]);
        }
    }
    Ok(reference)
}
