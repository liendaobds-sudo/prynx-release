//! Adapter VTracer cho MVP Phục hồi & Vector hóa Logo.
//!
//! Biên native chỉ nhận RGBA thô vì Pillow xử lý giải mã, EXIF và profile màu
//! ở backend. Hai mode được cố ý giới hạn theo kết quả audit G1: đen trắng và
//! palette do người dùng xác nhận; không có đường auto-color trong mã sản phẩm.

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::panic::{catch_unwind, AssertUnwindSafe};
use vtracer::progress::CancelToken;
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

fn build_image(width: usize, height: usize, rgba: Vec<u8>) -> Result<ColorImage, String> {
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
    mode: &str,
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

    match mode {
        "monochrome" => {
            if !palette.is_empty() {
                return Err("Chế độ đen trắng không nhận palette màu".to_string());
            }
            config.clustering = Clustering::Binary;
        }
        "fixed_palette" => {
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
        _ => return Err("Mode vector hóa logo không được hỗ trợ".to_string()),
    }
    Ok(config)
}

fn run_vtracer_guarded<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    // LOGO-REBUILD (audit 2026-08-02 §LR2.02): dependency VTracer/VisionCortex
    // từng panic với cluster rỗng. Chuyển unwind thành lỗi thường ngay tại biên Rust.
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(result) => result,
        Err(_) => Err("VTracer gặp lỗi nội bộ khi vector hóa ảnh".to_string()),
    }
}

fn render_svg(image: ColorImage, config: Config, cancel: CancelToken) -> Result<String, String> {
    run_vtracer_guarded(|| {
        let pipeline = config
            .build()
            .map_err(|error| format!("Không dựng được pipeline VTracer: {error}"))?;
        let mut ignore_progress = |_| {};
        let document = pipeline
            .run_with_progress(&image, &cancel, &mut ignore_progress)
            .map_err(|error| match error {
                vtracer::Error::Cancelled => "Đã hủy vector hóa logo".to_string(),
                _ => format!("VTracer không thể vector hóa ảnh: {error}"),
            })?;
        Ok(pipeline.writer.write(&document))
    })
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
    let image = build_image(width, height, rgba).map_err(PyValueError::new_err)?;
    let config = build_config(mode, &palette, smoothing, despeckle_size_px)
        .map_err(PyValueError::new_err)?;
    let token = cancel
        .map(|handle| handle.token.clone())
        .unwrap_or_default();

    // LOGO-REBUILD (audit 2026-07-29 §VL.MVP-B): nhả GIL để request hủy
    // có thể gọi `LogoVectorizerCancel.cancel()` trong lúc engine đang chạy.
    py.detach(move || render_svg(image, config, token))
        .map_err(PyRuntimeError::new_err)
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
        let error = run_vtracer_guarded::<()>(|| panic!("panic mô phỏng từ dependency"))
            .expect_err("panic dependency phải được đổi thành lỗi thường");
        assert!(error.contains("lỗi nội bộ"));
    }

    #[test]
    fn fixed_palette_is_mapped_to_vtracer_colors() {
        let config = build_config(
            "fixed_palette",
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
        let config = build_config("fixed_palette", &["#ef4444".to_string()], 1.0, 4).unwrap();
        assert_eq!(config.palette.len(), 1);
    }

    #[test]
    fn monochrome_does_not_accept_a_palette() {
        let error = build_config("monochrome", &["#000000".to_string()], 0.5, 4).unwrap_err();
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
            "fixed_palette",
            &["#ff0000".to_string(), "#ffffff".to_string()],
            0.5,
            0,
        )
        .unwrap();
        let svg = render_svg(image, config, CancelToken::new()).unwrap();
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
        let config = build_config("monochrome", &[], 0.5, 0).unwrap();
        let cancel = CancelToken::new();
        cancel.cancel();
        let error = render_svg(image, config, cancel).unwrap_err();
        assert_eq!(error, "Đã hủy vector hóa logo");
    }
}
