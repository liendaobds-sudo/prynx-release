//! Adapter VTracer cho MVP Phục hồi & Vector hóa Logo.
//!
//! Biên native chỉ nhận RGBA thô vì Pillow xử lý giải mã, EXIF và profile màu
//! ở backend. Hai mode được cố ý giới hạn theo kết quả audit G1: đen trắng và
//! palette do người dùng xác nhận; không có đường auto-color trong mã sản phẩm.

use crate::logo_engine::{
    build_structured_result, validate_structured_request, LogoBackendOutput, LogoEngineFacade,
    LogoEnginePhase, LogoEngineProfile, LogoEngineProgress, LogoEngineRequest,
    LogoStructuredResult, LogoTraceBackend, PhysicalSizeMm, StructuredResultOptions,
    CORE_ENGINE_NAME, CORE_ENGINE_VERSION, LOGO_STRUCTURED_RESULT_VERSION,
};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::panic::{catch_unwind, AssertUnwindSafe};
use vtracer::progress::{CancelToken, Phase as VTracerPhase, Progress as VTracerProgress};
use vtracer::{Clustering, Color, ColorImage, Config, FitMode, Hierarchical};

const ENGINE_VERSION: &str = "1.0.0-alpha.2";
const MAX_LOGO_PALETTE_COLORS: usize = 12;
// Một màu nền tùy chọn được thêm nội bộ rồi loại khỏi SVG sau khi phân vùng.
const MAX_ENGINE_PALETTE_COLORS: usize = MAX_LOGO_PALETTE_COLORS + 1;
const MAX_DESPECKLE_SIZE_PX: usize = 128;

/// Cờ hủy dùng chung giữa request preview và endpoint hủy của backend.
#[pyclass]
pub struct LogoVectorizerCancel {
    token: CancelToken,
}

#[pymethods]
impl LogoVectorizerCancel {
    #[new]
    pub fn new() -> Self {
        Self {
            token: CancelToken::new(),
        }
    }

    pub fn cancel(&self) {
        self.token.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
}

fn validate_rgba(width: usize, height: usize, rgba: &[u8]) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("Ảnh có chiều bằng 0".to_string());
    }
    let expected = width
        .checked_mul(height)
        .and_then(|count| count.checked_mul(4))
        .ok_or_else(|| "Kích thước ảnh tràn số".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "Đệm RGBA dài {} byte nhưng {}×{} cần {} byte",
            rgba.len(),
            width,
            height,
            expected
        ));
    }
    if rgba.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        return Err("Ảnh hoặc vùng đã chọn không có pixel nhìn thấy".to_string());
    }
    Ok(())
}

fn build_image(width: usize, height: usize, rgba: Vec<u8>) -> Result<ColorImage, String> {
    validate_rgba(width, height, &rgba)?;
    Ok(ColorImage {
        pixels: rgba,
        width,
        height,
    })
}

fn parse_hex_color(value: &str) -> Result<Color, String> {
    let hex = value
        .strip_prefix('#')
        .ok_or_else(|| "Màu palette phải có dạng #RRGGBB".to_string())?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Màu palette phải có dạng #RRGGBB".to_string());
    }
    let channel = |start| {
        u8::from_str_radix(&hex[start..start + 2], 16)
            .map_err(|_| "Màu palette phải có dạng #RRGGBB".to_string())
    };
    Ok(Color::new(channel(0)?, channel(2)?, channel(4)?))
}

fn build_config(
    profile: LogoEngineProfile,
    palette: &[String],
    smoothing: f64,
    despeckle_size_px: usize,
) -> Result<Config, String> {
    if !smoothing.is_finite() || !(0.0..=1.0).contains(&smoothing) {
        return Err("Độ mượt phải nằm trong khoảng 0 đến 1".to_string());
    }
    if despeckle_size_px > MAX_DESPECKLE_SIZE_PX {
        return Err(format!(
            "Khử nhiễu không được vượt {} px",
            MAX_DESPECKLE_SIZE_PX
        ));
    }

    let mut config = Config::default();
    config.hierarchical = Hierarchical::Stacked;
    config.mode = FitMode::Spline;
    config.simplify = (smoothing > 0.0).then_some(smoothing);
    config.filter_speckle = despeckle_size_px;
    config.path_precision = Some(4);
    config.optimize = 1;

    match profile {
        LogoEngineProfile::Silhouette => {
            if !palette.is_empty() {
                return Err("Chế độ đen trắng không nhận palette màu".to_string());
            }
            config.clustering = Clustering::Binary;
        }
        LogoEngineProfile::FlatColor => {
            if !(1..=MAX_ENGINE_PALETTE_COLORS).contains(&palette.len()) {
                return Err("Chế độ màu cần palette engine gồm 1–13 màu".to_string());
            }
            config.clustering = Clustering::ColorCluster;
            // LOGO-REBUILD (audit 2026-08-03 §LR2.03): Cutout tạo các vùng màu
            // không chồng lớp. Stacked từng sinh hàng nghìn path con trên một
            // mảng kín và buộc despeckle cao đến mức làm rơi dấu tiếng Việt.
            config.hierarchical = Hierarchical::Cutout;
            config.palette = palette
                .iter()
                .map(|value| parse_hex_color(value))
                .collect::<Result<Vec<_>, _>>()?;
        }
    }
    Ok(config)
}

fn run_logo_engine_guarded<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    // LOGO-REBUILD (audit 2026-08-02 §LR2.02): dependency VTracer/VisionCortex
    // từng panic với cluster rỗng. Chuyển unwind thành lỗi thường ngay tại biên Rust.
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(result) => result,
        Err(_) => Err("Engine vector hóa logo gặp lỗi nội bộ".to_string()),
    }
}

fn render_svg(
    image: ColorImage,
    config: Config,
    cancel: CancelToken,
    on_progress: &mut dyn FnMut(LogoEngineProgress),
) -> Result<String, String> {
    run_logo_engine_guarded(|| {
        let pipeline = config
            .build()
            .map_err(|error| format!("Không dựng được pipeline VTracer: {error}"))?;
        let mut report_progress = |progress: VTracerProgress| {
            let phase = match progress.phase {
                VTracerPhase::Segment => LogoEnginePhase::Segment,
                VTracerPhase::Compose => LogoEnginePhase::Compose,
                VTracerPhase::Optimize => LogoEnginePhase::Optimize,
            };
            on_progress(LogoEngineProgress::new(phase, progress.fraction));
        };
        let document = pipeline
            .run_with_progress(&image, &cancel, &mut report_progress)
            .map_err(|error| match error {
                vtracer::Error::Cancelled => "Đã hủy vector hóa logo".to_string(),
                _ => format!("VTracer không thể vector hóa ảnh: {error}"),
            })?;
        Ok(pipeline.writer.write(&document))
    })
}

struct VTracerPrepared {
    image: ColorImage,
    config: Config,
}

struct VTracerBackend;

impl LogoTraceBackend for VTracerBackend {
    type Prepared = VTracerPrepared;
    type Cancel = CancelToken;

    fn engine_name(&self) -> &'static str {
        "vtracer"
    }

    fn engine_version(&self) -> &'static str {
        ENGINE_VERSION
    }

    fn prepare(&self, request: LogoEngineRequest) -> Result<Self::Prepared, String> {
        // LOGO-ENGINE-V2 (audit 2026-08-10 Lô A): validation vẫn chạy trước
        // khi nhả GIL để giữ nguyên phân loại PyValueError của ABI cũ.
        let image = build_image(request.width, request.height, request.rgba)?;
        let config = build_config(
            request.profile,
            &request.palette,
            request.smoothing,
            request.despeckle_size_px,
        )?;
        Ok(VTracerPrepared { image, config })
    }

    fn trace(
        &self,
        prepared: Self::Prepared,
        cancel: Self::Cancel,
        on_progress: &mut dyn FnMut(LogoEngineProgress),
    ) -> Result<LogoBackendOutput, String> {
        let svg = render_svg(prepared.image, prepared.config, cancel, on_progress)?;
        Ok(LogoBackendOutput::legacy_svg(svg))
    }
}

/// Vector hóa một ảnh đã tiền xử lý; phần tính toán chạy ngoài Python GIL.
#[pyfunction]
#[pyo3(signature = (
    width,
    height,
    rgba,
    mode,
    palette=None,
    smoothing=0.5,
    despeckle_size_px=4,
    cancel=None
))]
#[allow(clippy::too_many_arguments)]
pub fn logo_vectorize_rgba(
    py: Python<'_>,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
    mode: &str,
    palette: Option<Vec<String>>,
    smoothing: f64,
    despeckle_size_px: usize,
    cancel: Option<PyRef<'_, LogoVectorizerCancel>>,
) -> PyResult<String> {
    let palette = palette.unwrap_or_default();
    let request = LogoEngineRequest::from_legacy_api(
        width,
        height,
        rgba,
        mode,
        palette,
        smoothing,
        despeckle_size_px,
    )
    .map_err(PyValueError::new_err)?;
    let facade = LogoEngineFacade::new(VTracerBackend);
    let prepared = facade.prepare(request).map_err(PyValueError::new_err)?;
    let token = cancel
        .map(|handle| handle.token.clone())
        .unwrap_or_default();

    // LOGO-REBUILD (audit 2026-07-29 §VL.MVP-B): nhả GIL để request hủy
    // có thể gọi `LogoVectorizerCancel.cancel()` trong lúc engine đang chạy.
    py.detach(move || {
        // Progress đã đi qua facade nhưng chưa đổi ABI ở Lô A; frontend sẽ nối
        // phase/progress trong lô contract riêng.
        let mut ignore_progress = |_| {};
        facade
            .trace(prepared, token, &mut ignore_progress)
            .map(|output| {
                debug_assert_eq!(output.provenance.engine, "vtracer");
                debug_assert!(output.scene.is_none());
                output.svg
            })
    })
    .map_err(PyRuntimeError::new_err)
}

fn physical_size_from_api(
    width_mm: Option<f64>,
    height_mm: Option<f64>,
) -> Result<Option<PhysicalSizeMm>, String> {
    match (width_mm, height_mm) {
        (Some(width_mm), Some(height_mm))
            if width_mm.is_finite()
                && height_mm.is_finite()
                && width_mm > 0.0
                && height_mm > 0.0 =>
        {
            Ok(Some(PhysicalSizeMm {
                width_mm,
                height_mm,
            }))
        }
        (Some(_), Some(_)) => Err("Kích thước vật lý phải là cặp mm hữu hạn lớn hơn 0".to_string()),
        (None, None) => Ok(None),
        _ => Err("Phải truyền đủ cả chiều rộng và chiều cao mm".to_string()),
    }
}

fn validate_structured_options(
    request: &LogoEngineRequest,
    background_label: Option<u16>,
    raster_scale: u32,
    min_iou: Option<f64>,
    max_mae: Option<f64>,
) -> Result<(), String> {
    // LOGO-ENGINE-V2 (audit 2026-08-11 Lô G1): giữ lỗi đầu vào ở PyValueError
    // trước khi nhả GIL; lỗi engine/artifact sau đó mới là PyRuntimeError.
    validate_structured_request(request, background_label)?;
    if request.despeckle_size_px > MAX_DESPECKLE_SIZE_PX {
        return Err(format!(
            "Khử nhiễu không được vượt {} px",
            MAX_DESPECKLE_SIZE_PX
        ));
    }
    if raster_scale == 0 {
        return Err("Raster scale QC phải lớn hơn 0".to_string());
    }
    if min_iou.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
        return Err("Ngưỡng IoU phải nằm trong khoảng 0–1".to_string());
    }
    if max_mae.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
        return Err("Ngưỡng MAE phải nằm trong khoảng 0–1".to_string());
    }
    Ok(())
}

fn render_structured(
    request: LogoEngineRequest,
    options: StructuredResultOptions,
    cancel: CancelToken,
) -> Result<LogoStructuredResult, String> {
    run_logo_engine_guarded(|| {
        build_structured_result(&request, options, &mut || cancel.is_cancelled())
    })
}

fn structured_result_to_pydict(
    py: Python<'_>,
    result: LogoStructuredResult,
) -> PyResult<Py<PyDict>> {
    let artifact = PyDict::new(py);
    artifact.set_item("sha256", &result.artifact_sha256)?;
    artifact.set_item("byte_len", result.artifact_byte_len)?;
    artifact.set_item("width_px", result.width_px)?;
    artifact.set_item("height_px", result.height_px)?;
    artifact.set_item(
        "physical_width_mm",
        result.physical_size_mm.map(|size| size.width_mm),
    )?;
    artifact.set_item(
        "physical_height_mm",
        result.physical_size_mm.map(|size| size.height_mm),
    )?;

    let provenance = PyDict::new(py);
    provenance.set_item("engine", &result.provenance.engine)?;
    provenance.set_item("engine_version", &result.provenance.engine_version)?;
    provenance.set_item("profile", &result.provenance.profile)?;
    provenance.set_item("settings_hash", &result.provenance.settings_hash)?;

    let metrics = PyDict::new(py);
    metrics.set_item("layer_count", result.metrics.layer_count)?;
    metrics.set_item("component_count", result.metrics.component_count)?;
    metrics.set_item("outer_count", result.metrics.outer_count)?;
    metrics.set_item("hole_count", result.metrics.hole_count)?;
    metrics.set_item("source_nodes", result.metrics.source_nodes)?;
    metrics.set_item("output_nodes", result.metrics.output_nodes)?;
    metrics.set_item("max_error_px", result.metrics.max_error_px)?;
    metrics.set_item("max_symmetric_distance_px", result.metrics.max_error_px)?;
    metrics.set_item("line_segments", result.metrics.line_segments)?;
    metrics.set_item("cubic_segments", result.metrics.cubic_segments)?;
    metrics.set_item("circle_count", result.metrics.circle_count)?;
    metrics.set_item("ellipse_count", result.metrics.ellipse_count)?;
    metrics.set_item(
        "max_smooth_tangent_jump_degrees",
        result.metrics.max_smooth_tangent_jump_degrees,
    )?;
    metrics.set_item(
        "artifact_max_tangent_jump_degrees",
        result.metrics.artifact_max_tangent_jump_degrees,
    )?;
    metrics.set_item("raster_scale", result.metrics.raster_scale)?;
    metrics.set_item("iou", result.metrics.iou)?;
    metrics.set_item("mae", result.metrics.mae)?;

    let output = PyDict::new(py);
    output.set_item("schema_version", result.schema_version)?;
    output.set_item("scene_version", result.scene_version)?;
    output.set_item("coordinate_system", result.coordinate_system)?;
    output.set_item("svg", result.svg)?;
    output.set_item("artifact", artifact)?;
    output.set_item("provenance", provenance)?;
    output.set_item("preprocess_hash", result.preprocess_hash)?;
    output.set_item("metrics", metrics)?;
    output.set_item("warnings", result.warnings)?;
    Ok(output.into())
}

/// Chạy core PrynX và trả SVG cùng provenance/metrics đã QC lại từ artifact cuối.
#[pyfunction]
#[pyo3(signature = (
    width,
    height,
    rgba,
    mode,
    palette=None,
    smoothing=0.5,
    despeckle_size_px=4,
    background_label=None,
    physical_width_mm=None,
    physical_height_mm=None,
    raster_scale=4,
    max_output_bytes=None,
    max_raster_pixels=None,
    min_iou=None,
    max_mae=None,
    curve_preset=None,
    cancel=None
))]
#[allow(clippy::too_many_arguments)]
pub fn logo_vectorize_structured_rgba(
    py: Python<'_>,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
    mode: &str,
    palette: Option<Vec<String>>,
    smoothing: f64,
    despeckle_size_px: usize,
    background_label: Option<u16>,
    physical_width_mm: Option<f64>,
    physical_height_mm: Option<f64>,
    raster_scale: u32,
    max_output_bytes: Option<usize>,
    max_raster_pixels: Option<usize>,
    min_iou: Option<f64>,
    max_mae: Option<f64>,
    curve_preset: Option<&str>,
    cancel: Option<PyRef<'_, LogoVectorizerCancel>>,
) -> PyResult<Py<PyDict>> {
    let request = LogoEngineRequest::from_legacy_api(
        width,
        height,
        rgba,
        mode,
        palette.unwrap_or_default(),
        smoothing,
        despeckle_size_px,
    )
    .map_err(PyValueError::new_err)?;
    let request = request
        .with_curve_preset(curve_preset)
        .map_err(PyValueError::new_err)?;
    validate_structured_options(&request, background_label, raster_scale, min_iou, max_mae)
        .map_err(PyValueError::new_err)?;
    let physical_size_mm = physical_size_from_api(physical_width_mm, physical_height_mm)
        .map_err(PyValueError::new_err)?;
    let options = StructuredResultOptions {
        background_label,
        physical_size_mm,
        raster_scale,
        max_output_bytes,
        max_raster_pixels,
        min_iou,
        max_mae,
    };
    let token = cancel
        .map(|handle| handle.token.clone())
        .unwrap_or_default();
    let result = py
        .detach(move || render_structured(request, options, token))
        .map_err(PyRuntimeError::new_err)?;
    structured_result_to_pydict(py, result)
}

#[pyfunction]
pub fn logo_vectorizer_info(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let result = PyDict::new(py);
    result.set_item("engine", "vtracer")?;
    result.set_item("version", ENGINE_VERSION)?;
    result.set_item("modes", ["monochrome", "fixed_palette"])?;
    result.set_item("auto_color", false)?;
    result.set_item("cancellable", true)?;
    result.set_item("max_palette_colors", MAX_LOGO_PALETTE_COLORS)?;
    result.set_item("structured_result", true)?;
    result.set_item("structured_result_version", LOGO_STRUCTURED_RESULT_VERSION)?;
    result.set_item("core_engine", CORE_ENGINE_NAME)?;
    result.set_item("core_engine_version", CORE_ENGINE_VERSION)?;
    result.set_item("core_profiles", ["silhouette", "flat_color"])?;
    result.set_item("structured_modes", ["monochrome", "fixed_palette"])?;
    result.set_item(
        "curve_presets",
        ["automatic", "faithful", "balanced", "trajectory_completion"],
    )?;
    result.set_item("geometry_metrics_version", 1)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_rgba_buffer_length() {
        let error = match build_image(2, 2, vec![0; 15]) {
            Ok(_) => panic!("đệm RGBA sai độ dài phải bị từ chối"),
            Err(error) => error,
        };
        assert!(error.contains("cần 16 byte"));
    }

    #[test]
    fn rejects_image_without_visible_pixels() {
        let error = match build_image(2, 2, vec![0; 16]) {
            Ok(_) => panic!("ảnh trong suốt hoàn toàn phải bị từ chối"),
            Err(error) => error,
        };
        assert!(error.contains("không có pixel nhìn thấy"));
    }

    #[test]
    fn dependency_panic_is_mapped_to_regular_error() {
        let error = run_logo_engine_guarded::<()>(|| panic!("panic mô phỏng từ dependency"))
            .expect_err("panic dependency phải được đổi thành lỗi thường");
        assert!(error.contains("lỗi nội bộ"));
    }

    #[test]
    fn fixed_palette_is_mapped_to_vtracer_colors() {
        let config = build_config(
            LogoEngineProfile::FlatColor,
            &["#ff0000".to_string(), "#00ff00".to_string()],
            1.0,
            48,
        )
        .unwrap();
        assert_eq!(config.clustering, Clustering::ColorCluster);
        assert_eq!(config.hierarchical, Hierarchical::Cutout);
        assert_eq!(config.palette.len(), 2);
        assert_eq!(config.filter_speckle, 48);
        assert_eq!(config.simplify, Some(1.0));
    }

    #[test]
    fn fixed_palette_accepts_one_logo_color() {
        let config = build_config(
            LogoEngineProfile::FlatColor,
            &["#ef4444".to_string()],
            1.0,
            4,
        )
        .unwrap();
        assert_eq!(config.palette.len(), 1);
    }

    #[test]
    fn monochrome_does_not_accept_a_palette() {
        let error = build_config(
            LogoEngineProfile::Silhouette,
            &["#000000".to_string()],
            0.5,
            4,
        )
        .unwrap_err();
        assert!(error.contains("không nhận palette"));
    }

    #[test]
    fn vector_output_uses_confirmed_palette() {
        let mut rgba = vec![255u8; 16 * 16 * 4];
        for y in 4..12 {
            for x in 4..12 {
                let offset = (y * 16 + x) * 4;
                rgba[offset..offset + 4].copy_from_slice(&[230, 20, 20, 255]);
            }
        }
        let image = build_image(16, 16, rgba).unwrap();
        let config = build_config(
            LogoEngineProfile::FlatColor,
            &["#ff0000".to_string(), "#ffffff".to_string()],
            0.5,
            0,
        )
        .unwrap();
        let svg = render_svg(image, config, CancelToken::new(), &mut |_| {}).unwrap();
        let normalized = svg.to_ascii_lowercase();
        assert!(
            normalized.contains("<svg"),
            "SVG không có phần tử gốc: {svg}"
        );
        assert!(
            normalized.contains("#ff0000"),
            "SVG không giữ màu đỏ: {svg}"
        );
        assert!(normalized.contains("#ffffff"));
    }

    #[test]
    fn pre_cancelled_job_stops_before_rendering() {
        let image = build_image(8, 8, vec![255; 8 * 8 * 4]).unwrap();
        let config = build_config(LogoEngineProfile::Silhouette, &[], 0.5, 0).unwrap();
        let cancel = CancelToken::new();
        cancel.cancel();
        let error = render_svg(image, config, cancel, &mut |_| {}).unwrap_err();
        assert_eq!(error, "Đã hủy vector hóa logo");
    }

    #[test]
    fn facade_keeps_vtracer_svg_contract() {
        let request = LogoEngineRequest::from_legacy_api(
            8,
            8,
            vec![255; 8 * 8 * 4],
            "monochrome",
            vec![],
            0.5,
            0,
        )
        .unwrap();
        let facade = LogoEngineFacade::new(VTracerBackend);
        let prepared = facade.prepare(request).unwrap();
        let output = facade
            .trace(prepared, CancelToken::new(), &mut |_| {})
            .unwrap();

        assert!(output.svg.to_ascii_lowercase().contains("<svg"));
        assert!(output.scene.is_none());
        assert_eq!(output.provenance.engine, "vtracer");
        assert_eq!(output.provenance.engine_version, ENGINE_VERSION);
        assert_eq!(output.provenance.profile, "silhouette");
    }

    #[test]
    fn facade_output_is_byte_identical_to_legacy_path() {
        let rgba = vec![255; 8 * 8 * 4];
        let direct_image = build_image(8, 8, rgba.clone()).unwrap();
        let direct_config = build_config(LogoEngineProfile::Silhouette, &[], 0.5, 0).unwrap();
        let direct_svg =
            render_svg(direct_image, direct_config, CancelToken::new(), &mut |_| {}).unwrap();

        let request =
            LogoEngineRequest::from_legacy_api(8, 8, rgba, "monochrome", vec![], 0.5, 0).unwrap();
        let facade = LogoEngineFacade::new(VTracerBackend);
        let prepared = facade.prepare(request).unwrap();
        let facade_svg = facade
            .trace(prepared, CancelToken::new(), &mut |_| {})
            .unwrap()
            .svg;

        assert_eq!(facade_svg, direct_svg);
    }

    fn flat_structured_request(despeckle_size_px: usize) -> LogoEngineRequest {
        const RED: [u8; 4] = [255, 0, 0, 255];
        const BLUE: [u8; 4] = [0, 0, 255, 255];
        let rgba = [RED, RED, BLUE, BLUE, RED, RED, BLUE, BLUE]
            .into_iter()
            .flatten()
            .collect();
        LogoEngineRequest::from_legacy_api(
            4,
            2,
            rgba,
            "fixed_palette",
            vec!["#ff0000".to_string(), "#0000ff".to_string()],
            0.5,
            despeckle_size_px,
        )
        .unwrap()
    }

    #[test]
    fn structured_core_result_is_deterministic_and_qc_exact() {
        let options = StructuredResultOptions {
            min_iou: Some(1.0),
            max_mae: Some(0.0),
            ..StructuredResultOptions::default()
        };
        let first =
            render_structured(flat_structured_request(0), options, CancelToken::new()).unwrap();
        let second =
            render_structured(flat_structured_request(0), options, CancelToken::new()).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.schema_version, LOGO_STRUCTURED_RESULT_VERSION);
        assert_eq!(first.provenance.engine, "prynx-logo-core");
        assert_eq!(first.provenance.profile, "flat_color");
        assert_eq!(first.metrics.layer_count, 2);
        assert_eq!(first.metrics.outer_count, 2);
        assert_eq!(first.metrics.iou, 1.0);
        assert_eq!(first.metrics.mae, 0.0);
        assert!((first.metrics.artifact_max_tangent_jump_degrees - 90.0).abs() < 1.0e-6);
        assert_eq!(first.artifact_sha256.len(), 64);
        assert!(first.svg.contains("data-prynx-engine=\"prynx-logo-core\""));
        assert!(first.warnings.is_empty());
    }

    #[test]
    fn structured_background_is_removed_before_artifact_qc() {
        let result = render_structured(
            flat_structured_request(0),
            StructuredResultOptions {
                background_label: Some(1),
                min_iou: Some(1.0),
                max_mae: Some(0.0),
                ..StructuredResultOptions::default()
            },
            CancelToken::new(),
        )
        .unwrap();

        assert_eq!(result.metrics.layer_count, 1);
        assert_eq!(result.metrics.outer_count, 1);
        assert_eq!(result.metrics.iou, 1.0);
        assert_eq!(result.metrics.mae, 0.0);
        assert!(result.svg.contains("#ff0000"));
        assert!(!result.svg.contains("#0000ff"));
    }

    #[test]
    fn structured_result_keeps_mm_and_only_declares_pending_silhouette_despeckle() {
        let result = render_structured(
            flat_structured_request(4),
            StructuredResultOptions {
                physical_size_mm: Some(PhysicalSizeMm {
                    width_mm: 40.0,
                    height_mm: 20.0,
                }),
                ..StructuredResultOptions::default()
            },
            CancelToken::new(),
        )
        .unwrap();

        assert_eq!(
            result.physical_size_mm,
            Some(PhysicalSizeMm {
                width_mm: 40.0,
                height_mm: 20.0,
            })
        );
        assert!(result.svg.contains("width=\"40mm\" height=\"20mm\""));
        assert!(!result
            .warnings
            .iter()
            .any(|warning| warning.contains("chưa áp dụng khử hạt")));

        let silhouette = LogoEngineRequest::from_legacy_api(
            2,
            2,
            [0_u8, 0, 0, 255].repeat(4),
            "monochrome",
            vec![],
            0.5,
            4,
        )
        .unwrap();
        let silhouette_result = render_structured(
            silhouette,
            StructuredResultOptions::default(),
            CancelToken::new(),
        )
        .unwrap();
        assert!(silhouette_result
            .warnings
            .iter()
            .any(|warning| warning.contains("Profile đen trắng chưa áp dụng khử hạt 4 px")));
    }

    #[test]
    fn structured_pre_cancelled_job_stops_before_core() {
        let cancel = CancelToken::new();
        cancel.cancel();
        let error = render_structured(
            flat_structured_request(0),
            StructuredResultOptions::default(),
            cancel,
        )
        .unwrap_err();

        assert_eq!(error, "Đã hủy vector hóa logo");
    }

    #[test]
    fn structured_api_rejects_partial_or_invalid_mm_pair() {
        assert!(physical_size_from_api(Some(40.0), None)
            .unwrap_err()
            .contains("đủ cả"));
        assert!(physical_size_from_api(Some(f64::NAN), Some(20.0))
            .unwrap_err()
            .contains("hữu hạn"));
        assert_eq!(physical_size_from_api(None, None).unwrap(), None);
    }
}
