//! Crate THỬ NGHIỆM cho cổng G1 — không phải mã sản phẩm.
//!
//! Trả lời bốn câu hỏi mà đường CLI không trả lời được:
//!
//! 1. crate `vtracer 1.0.0-alpha.2` có biên dịch và liên kết vào một `cdylib`
//!    PyO3 cùng phiên bản pyo3 mà `pdfcompare_native` đang dùng hay không;
//! 2. `CancelToken` có hủy thật giữa lúc chạy hay không — đây là điểm §LR.07 của
//!    báo cáo khảo sát: hiện nút Hủy chỉ ngừng chờ ở UI còn engine vẫn chạy hết;
//! 3. `Session` có tái dùng phân vùng đã cache khi chỉ đổi tham số làm mượt hay
//!    không — quyết định việc preview có mượt được khi kéo slider;
//! 4. kích thước artifact tăng bao nhiêu, để cân đường Rust với đường wheel.
//!
//! Nhận **RGBA thô** thay vì byte PNG là cố ý: backend PrynX đã giải mã ảnh bằng
//! Pillow/OpenCV trước khi xuống native, nên đây đúng là hình dạng hợp đồng thật.
//! Không nhét bộ giải mã ảnh vào Rust để rồi giải mã hai lần.

use std::time::{Duration, Instant};

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use vtracer::progress::{CancelToken, Phase, Progress};
use vtracer::{ColorImage, Clustering, Config, FitMode, Hierarchical, Session};

/// Dựng `ColorImage` từ RGBA thô, kiểm kích thước trước khi tin vào nó.
fn build_image(width: usize, height: usize, rgba: &[u8]) -> PyResult<ColorImage> {
    let expected = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| PyValueError::new_err("Kích thước ảnh tràn số"))?;
    if width == 0 || height == 0 {
        return Err(PyValueError::new_err("Ảnh có chiều bằng 0"));
    }
    if rgba.len() != expected {
        return Err(PyValueError::new_err(format!(
            "Đệm RGBA dài {} byte nhưng {}×{} cần {} byte",
            rgba.len(),
            width,
            height,
            expected
        )));
    }
    Ok(ColorImage {
        pixels: rgba.to_vec(),
        width,
        height,
    })
}

/// Ánh xạ tham số mức giao diện sang `Config`. Giữ cùng ngữ nghĩa với
/// `engines.py` để hai đường so được với nhau.
fn build_config(
    max_colors: Option<usize>,
    simplify: Option<f64>,
    filter_speckle: usize,
    binary: bool,
    adaptive: bool,
    cutout: bool,
    polygon: bool,
) -> Config {
    let mut cfg = Config::default();
    cfg.clustering = if binary {
        Clustering::Binary
    } else {
        Clustering::ColorCluster
    };
    cfg.hierarchical = if cutout {
        Hierarchical::Cutout
    } else {
        Hierarchical::Stacked
    };
    cfg.mode = if polygon {
        FitMode::Polygon
    } else {
        FitMode::Spline
    };
    cfg.filter_speckle = filter_speckle;
    cfg.simplify = simplify;
    cfg.path_precision = Some(4);
    cfg.max_colors = max_colors;
    cfg.binary_adaptive = adaptive;
    cfg
}

/// Vector hóa một lần, trả SVG.
#[pyfunction]
#[pyo3(signature = (width, height, rgba, max_colors=None, simplify=None,
                    filter_speckle=4, binary=false, adaptive=false,
                    cutout=false, polygon=false))]
#[allow(clippy::too_many_arguments)]
fn trace_rgba(
    width: usize,
    height: usize,
    rgba: &[u8],
    max_colors: Option<usize>,
    simplify: Option<f64>,
    filter_speckle: usize,
    binary: bool,
    adaptive: bool,
    cutout: bool,
    polygon: bool,
) -> PyResult<String> {
    let img = build_image(width, height, rgba)?;
    let cfg = build_config(
        max_colors, simplify, filter_speckle, binary, adaptive, cutout, polygon,
    );
    let mut session = Session::new(img);
    session
        .render_svg(&cfg)
        .map_err(|e| PyRuntimeError::new_err(format!("vtracer lỗi: {e:?}")))
}

/// Câu hỏi 2 — hủy thật.
///
/// Chạy pipeline và gọi `cancel()` từ trong callback tiến độ ngay khi thấy báo
/// cáo đầu tiên của pha đã chọn. Trả về (đã hủy?, số báo cáo, ms tới lúc dừng,
/// pha cuối). Nếu `cancelled` là false thì token KHÔNG hủy được thật, và cả
/// hướng "Hủy có tác dụng lên engine" phải bị gạch khỏi kế hoạch.
#[pyfunction]
#[pyo3(signature = (width, height, rgba, max_colors=None, cancel_after_reports=1))]
fn probe_cancel(
    width: usize,
    height: usize,
    rgba: &[u8],
    max_colors: Option<usize>,
    cancel_after_reports: usize,
) -> PyResult<(bool, usize, f64, String)> {
    let img = build_image(width, height, rgba)?;
    let cfg = build_config(max_colors, None, 4, false, false, false, false);
    let pipeline = cfg
        .build()
        .map_err(|e| PyRuntimeError::new_err(format!("build pipeline lỗi: {e:?}")))?;

    let cancel = CancelToken::new();
    let mut reports = 0usize;
    let mut last_phase = String::from("(chưa có báo cáo)");
    let started = Instant::now();
    {
        let cancel_ref = &cancel;
        let mut on_progress = |p: Progress| {
            reports += 1;
            last_phase = match p.phase {
                Phase::Segment => "Segment",
                Phase::Compose => "Compose",
                Phase::Optimize => "Optimize",
            }
            .to_string();
            if reports >= cancel_after_reports {
                cancel_ref.cancel();
            }
        };
        let result = pipeline.run_with_progress(&img, &cancel, &mut on_progress);
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        return match result {
            Ok(_) => Ok((false, reports, elapsed_ms, last_phase)),
            Err(vtracer::Error::Cancelled) => {
                Ok((true, reports, elapsed_ms, last_phase))
            }
            Err(err) => Err(PyRuntimeError::new_err(format!(
                "pipeline lỗi, không phải hủy: {err}"
            ))),
        };
    }
}

/// Câu hỏi 3 — `Session` có tái dùng phân vùng đã cache không.
///
/// Lần 1 phân vùng rồi dựng. Lần 2 chỉ đổi `corner_threshold` (tham số làm mượt,
/// không thuộc `SegmentKey`) nên đáng ra KHÔNG phải phân vùng lại. Lần 3 đổi
/// `filter_speckle` (thuộc `SegmentKey`) nên BẮT BUỘC phân vùng lại.
///
/// Trả (ms lần 1, ms lần 2 chỉ đổi độ mượt, ms lần 3 đổi tham số phân vùng).
/// Nếu lần 2 không nhanh hơn hẳn lần 1 thì cache không có tác dụng thật, và
/// preview kéo slider sẽ phải chịu toàn bộ chi phí phân vùng mỗi lần.
#[pyfunction]
#[pyo3(signature = (width, height, rgba, max_colors=None))]
fn probe_session_cache(
    width: usize,
    height: usize,
    rgba: &[u8],
    max_colors: Option<usize>,
) -> PyResult<(f64, f64, f64)> {
    let img = build_image(width, height, rgba)?;
    let mut session = Session::new(img);
    let mut cfg = build_config(max_colors, None, 4, false, false, false, false);

    let t0 = Instant::now();
    session
        .render_svg(&cfg)
        .map_err(|e| PyRuntimeError::new_err(format!("lần 1 lỗi: {e:?}")))?;
    let first_ms = t0.elapsed().as_secs_f64() * 1000.0;

    cfg.corner_threshold = 95;
    let t1 = Instant::now();
    session
        .render_svg(&cfg)
        .map_err(|e| PyRuntimeError::new_err(format!("lần 2 lỗi: {e:?}")))?;
    let smooth_ms = t1.elapsed().as_secs_f64() * 1000.0;

    cfg.filter_speckle = 32;
    let t2 = Instant::now();
    session
        .render_svg(&cfg)
        .map_err(|e| PyRuntimeError::new_err(format!("lần 3 lỗi: {e:?}")))?;
    let resegment_ms = t2.elapsed().as_secs_f64() * 1000.0;

    Ok((first_ms, smooth_ms, resegment_ms))
}

/// Đo tiến độ trên một lần chạy trọn vẹn: có bao nhiêu báo cáo, các pha nào.
/// Dùng để biết có đủ hạt để vẽ thanh tiến trình thật hay không.
#[pyfunction]
#[pyo3(signature = (width, height, rgba, max_colors=None))]
fn probe_progress(
    width: usize,
    height: usize,
    rgba: &[u8],
    max_colors: Option<usize>,
) -> PyResult<Vec<(String, f32)>> {
    let img = build_image(width, height, rgba)?;
    let cfg = build_config(max_colors, None, 4, false, false, false, false);
    let pipeline = cfg
        .build()
        .map_err(|e| PyRuntimeError::new_err(format!("build pipeline lỗi: {e:?}")))?;
    let cancel = CancelToken::new();
    let mut seen: Vec<(String, f32)> = Vec::new();
    {
        let mut on_progress = |p: Progress| {
            let name = match p.phase {
                Phase::Segment => "Segment",
                Phase::Compose => "Compose",
                Phase::Optimize => "Optimize",
            };
            seen.push((name.to_string(), p.fraction));
        };
        pipeline
            .run_with_progress(&img, &cancel, &mut on_progress)
            .map_err(|e| PyRuntimeError::new_err(format!("chạy lỗi: {e:?}")))?;
    }
    Ok(seen)
}

/// Thông tin để ghi vào báo cáo spike, đọc từ chính bản build.
#[pyfunction]
fn probe_info(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("probe_crate", env!("CARGO_PKG_NAME"))?;
    d.set_item("probe_version", env!("CARGO_PKG_VERSION"))?;
    d.set_item("vtracer_pinned", "=1.0.0-alpha.2")?;
    d.set_item("pyo3_major_minor", "0.29")?;
    d.set_item("has_cancel_token", true)?;
    d.set_item("has_progress_phases", true)?;
    d.set_item("has_session_cache", true)?;
    d.set_item("has_max_colors", true)?;
    d.set_item("has_fixed_palette", true)?;
    d.set_item("has_adaptive_threshold", true)?;
    d.set_item("has_mosaic_cutout", true)?;
    Ok(d)
}

#[pymodule]
fn logo_vectorizer_probe(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(trace_rgba, m)?)?;
    m.add_function(wrap_pyfunction!(probe_cancel, m)?)?;
    m.add_function(wrap_pyfunction!(probe_session_cache, m)?)?;
    m.add_function(wrap_pyfunction!(probe_progress, m)?)?;
    m.add_function(wrap_pyfunction!(probe_info, m)?)?;
    Ok(())
}

/// Giữ `Duration` trong phạm vi dùng để tránh cảnh báo import không dùng nếu
/// về sau bỏ nhánh đo thời gian.
#[allow(dead_code)]
fn _unused_duration() -> Duration {
    Duration::from_millis(0)
}
