//! Lớp binding PyO3 cho PrynX Print Engine (PPE).
//!
//! Chỉ làm ba việc: nhận tham số, gọi `print_engine`, đóng gói kết quả. Mọi logic
//! prepress nằm trong crate `print_engine` để test được bằng `cargo test` mà
//! không cần Python.
//!
//! Contract trả về **khớp sẵn** cấu trúc plate mà `backend/app/core/separations.py`
//! đang dựng: mỗi kẽm là mảng `u8` với `255 = 100% mực`, đúng chiều của
//! `ink_density` mà lớp Python nén zlib + base64. Nhờ vậy đổi engine không phải
//! đổi contract API hay code frontend.

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};
use rayon::prelude::*;

use print_engine::color::icc::SoftProofSettings;
use print_engine::color::space::OutputPreviewFilter;
use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::ink::SpotAlternate;
use print_engine::oc::OptionalContentUsage;
use print_engine::page::{
    open as ppe_open, render_page_managed, render_page_managed_region, PageBox, RasterClip,
};
use print_engine::session::{
    RenderSession, ResourceCacheStats, SessionOpenTimings, SessionRenderTimings,
    SESSION_ENGINE_VERSION,
};
use print_engine::text::outlines::StreamKey;
use print_engine::{CancelToken, PpeError};

const STALE_REQUEST_PREFIX: &str = "PPE_STALE_REQUEST";

fn output_preview_filter_from_str(value: &str) -> PyResult<OutputPreviewFilter> {
    match value.trim().to_ascii_lowercase().as_str() {
        "all" => Ok(OutputPreviewFilter::All),
        "device-cmyk" => Ok(OutputPreviewFilter::DeviceCmyk),
        "device-rgb" => Ok(OutputPreviewFilter::DeviceRgb),
        "device-gray" => Ok(OutputPreviewFilter::DeviceGray),
        "spot" => Ok(OutputPreviewFilter::Spot),
        "text" => Ok(OutputPreviewFilter::Text),
        "images" => Ok(OutputPreviewFilter::Images),
        "line-art" => Ok(OutputPreviewFilter::LineArt),
        "smooth-shades" => Ok(OutputPreviewFilter::SmoothShades),
        other => Err(PyValueError::new_err(format!(
            "output_preview_filter không hợp lệ: {other}"
        ))),
    }
}

fn optional_content_usage_from_str(value: &str) -> PyResult<OptionalContentUsage> {
    match value.trim().to_ascii_lowercase().as_str() {
        "print" => Ok(OptionalContentUsage::Print),
        "view" => Ok(OptionalContentUsage::View),
        other => Err(PyValueError::new_err(format!(
            "optional_content_usage không hợp lệ: {other} (print|view)"
        ))),
    }
}

fn softproof_settings(
    simulate_paper_color: bool,
    simulate_black_ink: bool,
    page_background_rgb: Option<(u8, u8, u8)>,
) -> SoftProofSettings {
    SoftProofSettings {
        simulate_paper_color,
        simulate_black_ink,
        page_background_rgb: page_background_rgb.map(|(r, g, b)| [r, g, b]),
    }
}

fn page_box_from_str(page_box: &str) -> PyResult<PageBox> {
    match page_box {
        "media" => Ok(PageBox::Media),
        "crop" => Ok(PageBox::Crop),
        "trim" => Ok(PageBox::Trim),
        "bleed" => Ok(PageBox::Bleed),
        "art" => Ok(PageBox::Art),
        other => Err(PyValueError::new_err(format!(
            "page_box không hợp lệ: {other} (media|crop|trim|bleed|art)"
        ))),
    }
}

fn raster_clip_from_parts(
    clip_x: Option<u32>,
    clip_y: Option<u32>,
    clip_width: Option<u32>,
    clip_height: Option<u32>,
) -> PyResult<Option<RasterClip>> {
    match (clip_x, clip_y, clip_width, clip_height) {
        (None, None, None, None) => Ok(None),
        (Some(x), Some(y), Some(width), Some(height)) if width > 0 && height > 0 => {
            Ok(Some(RasterClip {
                x,
                y,
                width,
                height,
            }))
        }
        (Some(_), Some(_), Some(_), Some(_)) => Err(PyValueError::new_err(
            "clip PPE phải có width/height lớn hơn 0",
        )),
        _ => Err(PyValueError::new_err(
            "clip PPE phải truyền đủ x/y/width/height",
        )),
    }
}

fn megabytes_to_bytes(value: usize, name: &str, allow_zero: bool) -> PyResult<usize> {
    value
        .checked_mul(1024 * 1024)
        .filter(|bytes| allow_zero || *bytes > 0)
        .ok_or_else(|| {
            PyValueError::new_err(format!(
                "{name} must be {}",
                if allow_zero {
                    "a valid non-negative integer"
                } else {
                    "greater than zero"
                }
            ))
        })
}

fn duration_ms(value: Duration) -> f64 {
    value.as_secs_f64() * 1_000.0
}

fn identity_hash(session: &RenderSession) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    session.identity().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[derive(Clone)]
struct SessionInfoSnapshot {
    identity: String,
    generation: u64,
    page_count: usize,
    valid: bool,
    stats: ResourceCacheStats,
}

struct SessionRenderOutput {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
    rotate: i32,
    degraded: bool,
    ink_unsound: bool,
    timings: SessionRenderTimings,
    stats_before: ResourceCacheStats,
    stats_after: ResourceCacheStats,
    identity: String,
    session_generation: u64,
}

type ActiveCancelSlot = Arc<Mutex<Option<(u64, CancelToken)>>>;

fn install_cancel_token_in_slot(
    active: &Mutex<Option<(u64, CancelToken)>>,
    generation: u64,
    token: CancelToken,
) -> Result<(), ()> {
    let mut active = active.lock().map_err(|_| ())?;
    if active
        .as_ref()
        .is_some_and(|(active_generation, _)| *active_generation >= generation)
    {
        token.cancel();
        return Ok(());
    }
    if let Some((_, previous)) = active.replace((generation, token)) {
        previous.cancel();
    }
    Ok(())
}

fn cancel_active_through_in_slot(
    active: &Mutex<Option<(u64, CancelToken)>>,
    generation: u64,
) -> Result<bool, ()> {
    let active = active.lock().map_err(|_| ())?;
    Ok(active.as_ref().is_some_and(|(active_generation, token)| {
        *active_generation <= generation && token.cancel()
    }))
}

fn clear_active_generation_in_slot(active: &Mutex<Option<(u64, CancelToken)>>, generation: u64) {
    if let Ok(mut active) = active.lock() {
        if active
            .as_ref()
            .is_some_and(|(active_generation, _)| *active_generation == generation)
        {
            active.take();
        }
    }
}

/// Chỉ xóa token nếu slot vẫn thuộc đúng generation này; request mới hơn có thể đã thay slot.
struct ActiveCancelGuard {
    active: ActiveCancelSlot,
    generation: u64,
}

impl Drop for ActiveCancelGuard {
    fn drop(&mut self) {
        clear_active_generation_in_slot(&self.active, self.generation);
    }
}

/// Owner native của một PPE document session.
///
/// Mỗi instance có Mutex riêng: render cùng tài liệu được serialize, còn session
/// của tài liệu khác không đi qua một khóa toàn cục. `owner_id` chặn tab khác đóng
/// hoặc hủy nhầm session trước khi lớp lease/ref-count đầy đủ được nối ở Lô 2C.
#[pyclass(name = "PpeRenderSession")]
pub struct PpeRenderSession {
    inner: Arc<Mutex<RenderSession>>,
    owner_id: String,
    last_accepted_generation: Arc<AtomicU64>,
    latest_request_generation: Arc<AtomicU64>,
    active_cancel: ActiveCancelSlot,
    closed: Arc<AtomicBool>,
    open_timings: SessionOpenTimings,
}

#[pymethods]
impl PpeRenderSession {
    #[new]
    #[pyo3(signature = (
        pdf_path,
        owner_id,
        cmyk_profile,
        rgb_profile = None,
        render_intent = 1,
        resource_cache_budget_mb = 128,
    ))]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        py: Python<'_>,
        pdf_path: &str,
        owner_id: &str,
        cmyk_profile: &str,
        rgb_profile: Option<&str>,
        render_intent: i32,
        resource_cache_budget_mb: usize,
    ) -> PyResult<Self> {
        let owner_id = owner_id.trim();
        if owner_id.is_empty() {
            return Err(PyValueError::new_err("owner_id PPE không được rỗng"));
        }
        if cmyk_profile.is_empty() {
            return Err(PyValueError::new_err("soft-proof session cần cmyk_profile"));
        }
        let cache_budget_bytes =
            megabytes_to_bytes(resource_cache_budget_mb, "resource_cache_budget_mb", true)?;
        let pdf_path = pdf_path.to_owned();
        let cmyk_profile = cmyk_profile.to_owned();
        let rgb_profile = rgb_profile.map(str::to_owned);
        let intent = RenderIntent::from_pdf(render_intent);
        let (session, open_timings) = py
            .detach(move || {
                let (session, timings) = RenderSession::open_with_profile_paths_timed(
                    Path::new(&pdf_path),
                    Some(Path::new(&cmyk_profile)),
                    rgb_profile.as_deref().map(Path::new),
                    intent,
                )?;
                Ok::<_, print_engine::error::PpeError>((
                    session.with_resource_cache_budget(cache_budget_bytes),
                    timings,
                ))
            })
            .map_err(|error| PyRuntimeError::new_err(format!("PPE: {error}")))?;

        Ok(Self {
            inner: Arc::new(Mutex::new(session)),
            owner_id: owner_id.to_owned(),
            last_accepted_generation: Arc::new(AtomicU64::new(0)),
            latest_request_generation: Arc::new(AtomicU64::new(0)),
            active_cancel: Arc::new(Mutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
            open_timings,
        })
    }

    /// Metadata/timing mở session; không giữ GIL trong lúc chờ một render đang chạy.
    pub fn info(&self, py: Python<'_>, owner_id: &str) -> PyResult<Py<PyDict>> {
        self.check_owner(owner_id)?;
        let inner = Arc::clone(&self.inner);
        let snapshot = py
            .detach(move || {
                let session = inner
                    .lock()
                    .map_err(|_| "PPE RenderSession lock bị poison".to_string())?;
                Ok::<_, String>(SessionInfoSnapshot {
                    identity: identity_hash(&session),
                    generation: session.generation(),
                    page_count: session.page_count(),
                    valid: session.is_valid(),
                    stats: session.resource_cache_stats(),
                })
            })
            .map_err(PyRuntimeError::new_err)?;
        self.info_dict(py, snapshot)
    }

    #[pyo3(signature = (
        owner_id,
        request_generation,
        page = 1,
        dpi = 150.0,
        page_box = "crop",
        fallback_font = None,
        simulate_overprint = true,
        output_preview_filter = "all",
        simulate_paper_color = false,
        simulate_black_ink = false,
        page_background_rgb = None,
        memory_budget_mb = 512,
        clip_x = None,
        clip_y = None,
        clip_width = None,
        clip_height = None,
        optional_content_usage = "print",
        render_annotations = false,
    ))]
    #[allow(clippy::too_many_arguments)]
    pub fn render_softproof(
        &self,
        py: Python<'_>,
        owner_id: &str,
        request_generation: u64,
        page: usize,
        dpi: f32,
        page_box: &str,
        fallback_font: Option<&str>,
        simulate_overprint: bool,
        output_preview_filter: &str,
        simulate_paper_color: bool,
        simulate_black_ink: bool,
        page_background_rgb: Option<(u8, u8, u8)>,
        memory_budget_mb: usize,
        clip_x: Option<u32>,
        clip_y: Option<u32>,
        clip_width: Option<u32>,
        clip_height: Option<u32>,
        optional_content_usage: &str,
        render_annotations: bool,
    ) -> PyResult<Py<PyDict>> {
        self.check_owner(owner_id)?;
        if page == 0 {
            return Err(PyValueError::new_err(
                "page là chỉ số 1-based, không nhận 0",
            ));
        }
        if request_generation == 0 {
            return Err(PyValueError::new_err(
                "request_generation PPE phải lớn hơn 0",
            ));
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(PyRuntimeError::new_err(format!(
                "{STALE_REQUEST_PREFIX}: PPE RenderSession đã đóng"
            )));
        }
        let which_box = page_box_from_str(page_box)?;
        let clip = raster_clip_from_parts(clip_x, clip_y, clip_width, clip_height)?;
        let output_preview_filter = output_preview_filter_from_str(output_preview_filter)?;
        let optional_content_usage = optional_content_usage_from_str(optional_content_usage)?;
        let proof_settings = softproof_settings(
            simulate_paper_color,
            simulate_black_ink,
            page_background_rgb,
        );
        let memory_budget_bytes = megabytes_to_bytes(memory_budget_mb, "memory_budget_mb", false)?;
        let fallback_font = fallback_font.map(str::to_owned);

        let previous = self
            .last_accepted_generation
            .fetch_max(request_generation, Ordering::AcqRel);
        if previous > 0 && request_generation <= previous {
            return Err(PyRuntimeError::new_err(format!(
                "{STALE_REQUEST_PREFIX}: generation {request_generation} không mới hơn {previous}"
            )));
        }
        self.latest_request_generation
            .fetch_max(request_generation, Ordering::AcqRel);

        let cancel_token = CancelToken::new();
        self.install_cancel_token(request_generation, cancel_token.clone())?;

        let inner = Arc::clone(&self.inner);
        let latest = Arc::clone(&self.latest_request_generation);
        let active_cancel = Arc::clone(&self.active_cancel);
        let closed = Arc::clone(&self.closed);
        let output = py
            .detach(move || -> Result<SessionRenderOutput, String> {
                let _active_cancel_guard = ActiveCancelGuard {
                    active: active_cancel,
                    generation: request_generation,
                };
                if closed.load(Ordering::Acquire)
                    || latest.load(Ordering::Acquire) != request_generation
                {
                    return Err(format!(
                        "{STALE_REQUEST_PREFIX}: request đã bị thay thế trước raster"
                    ));
                }
                let fallback_font = fallback_font
                    .as_deref()
                    .map(std::fs::read)
                    .transpose()
                    .map_err(|error| format!("không đọc được fallback_font: {error}"))?;
                // CORRECTNESS (audit 2026-08-31 §LÔ-B): policy Viewer phải đi
                // xuyên binding; mặc định vẫn là /Print và không dựng annotation.
                let mut opts = RenderOptions::softproof()
                    .with_optional_content_usage(optional_content_usage)
                    .with_annotations(render_annotations)
                    .with_overprint_simulation(simulate_overprint)
                    .with_output_preview_filter(output_preview_filter)
                    .with_softproof_settings(proof_settings)
                    .with_memory_budget_bytes(memory_budget_bytes)
                    .with_cancel_token(cancel_token);
                if let Some(data) = fallback_font {
                    opts = opts.with_fallback_font(Arc::new(data));
                }

                // PERF (audit 2026-08-09 §L2B): khóa sau khi nhả GIL. Session khác
                // có Mutex khác nên vẫn chạy song song; request cùng session xếp hàng.
                let mut session = inner
                    .lock()
                    .map_err(|_| "PPE RenderSession lock bị poison".to_string())?;
                if closed.load(Ordering::Acquire)
                    || latest.load(Ordering::Acquire) != request_generation
                {
                    return Err(format!(
                        "{STALE_REQUEST_PREFIX}: request đã bị thay thế khi chờ session"
                    ));
                }
                let stats_before = session.resource_cache_stats();
                let (rendered, timings) = session
                    .render_page_srgb_region_timed(page, dpi, which_box, opts, clip)
                    .map_err(|error| match error {
                        PpeError::Cancelled => {
                            format!("{STALE_REQUEST_PREFIX}: core đã dừng request lỗi thời")
                        }
                        other => format!("PPE: {other}"),
                    })?;
                if closed.load(Ordering::Acquire)
                    || latest.load(Ordering::Acquire) != request_generation
                {
                    return Err(format!(
                        "{STALE_REQUEST_PREFIX}: bỏ bitmap của request đã bị thay thế"
                    ));
                }
                let stats_after = session.resource_cache_stats();
                Ok(SessionRenderOutput {
                    width: rendered.width,
                    height: rendered.height,
                    rgb: rendered.rgb,
                    rotate: rendered.rotate,
                    degraded: rendered.warnings.degrades_accuracy(),
                    ink_unsound: rendered.warnings.ink_unsound(),
                    timings,
                    stats_before,
                    stats_after,
                    identity: identity_hash(&session),
                    session_generation: session.generation(),
                })
            })
            .map_err(|message| {
                if message.starts_with(STALE_REQUEST_PREFIX) {
                    PyRuntimeError::new_err(message)
                } else {
                    PyRuntimeError::new_err(message)
                }
            })?;
        // Checkpoint cuối nằm ngoài `detach`: cancel/close có thể đến sau lần kiểm tra cuối
        // của worker nhưng trước khi Python nhận bytes. Khi đó tuyệt đối không phát bitmap cũ.
        if self.closed.load(Ordering::Acquire)
            || self.latest_request_generation.load(Ordering::Acquire) != request_generation
        {
            return Err(PyRuntimeError::new_err(format!(
                "{STALE_REQUEST_PREFIX}: request đã bị thay thế trước khi trả bitmap"
            )));
        }
        self.render_dict(py, request_generation, output)
    }

    /// Đánh dấu generation đang chạy là lỗi thời; raster có thể còn chạy tới
    /// checkpoint của core, nhưng bitmap chắc chắn bị bỏ trước khi trả về Python.
    pub fn cancel(&self, owner_id: &str, request_generation: u64) -> PyResult<bool> {
        self.check_owner(owner_id)?;
        let cancelled_through = request_generation.saturating_add(1);
        let previous = self
            .latest_request_generation
            .fetch_max(cancelled_through, Ordering::AcqRel);
        let cancelled_active = self.cancel_active_through(request_generation)?;
        Ok(cancelled_through > previous || cancelled_active)
    }

    pub fn close(&self, py: Python<'_>, owner_id: &str) -> PyResult<bool> {
        self.check_owner(owner_id)?;
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(false);
        }
        self.latest_request_generation
            .store(u64::MAX, Ordering::Release);
        self.cancel_active_through(u64::MAX)?;
        let inner = Arc::clone(&self.inner);
        py.detach(move || {
            let mut session = inner
                .lock()
                .map_err(|_| "PPE RenderSession lock bị poison".to_string())?;
            session.close();
            Ok::<_, String>(())
        })
        .map_err(PyRuntimeError::new_err)?;
        Ok(true)
    }
}

impl PpeRenderSession {
    fn install_cancel_token(&self, generation: u64, token: CancelToken) -> PyResult<()> {
        install_cancel_token_in_slot(&self.active_cancel, generation, token)
            .map_err(|_| PyRuntimeError::new_err("PPE cancel lock bị poison"))
    }

    fn cancel_active_through(&self, generation: u64) -> PyResult<bool> {
        cancel_active_through_in_slot(&self.active_cancel, generation)
            .map_err(|_| PyRuntimeError::new_err("PPE cancel lock bị poison"))
    }

    fn check_owner(&self, owner_id: &str) -> PyResult<()> {
        if owner_id != self.owner_id {
            return Err(PyValueError::new_err(
                "owner_id không sở hữu PPE RenderSession này",
            ));
        }
        Ok(())
    }

    fn info_dict(&self, py: Python<'_>, snapshot: SessionInfoSnapshot) -> PyResult<Py<PyDict>> {
        let timings = PyDict::new(py);
        timings.set_item("total", duration_ms(self.open_timings.total))?;
        timings.set_item("open", duration_ms(self.open_timings.open))?;
        timings.set_item("parse", duration_ms(self.open_timings.parse))?;
        timings.set_item("resource", duration_ms(self.open_timings.resource))?;
        timings.set_item("color", duration_ms(self.open_timings.color))?;
        timings.set_item("encode", 0.0)?;

        let out = PyDict::new(py);
        out.set_item("engine", "ppe")?;
        out.set_item("session_version", SESSION_ENGINE_VERSION)?;
        out.set_item("document_identity", snapshot.identity)?;
        out.set_item("session_generation", snapshot.generation)?;
        out.set_item("page_count", snapshot.page_count)?;
        out.set_item(
            "valid",
            snapshot.valid && !self.closed.load(Ordering::Acquire),
        )?;
        out.set_item("cache", cache_stats_dict(py, snapshot.stats)?)?;
        out.set_item("open_timings_ms", timings)?;
        Ok(out.into())
    }

    fn render_dict(
        &self,
        py: Python<'_>,
        request_generation: u64,
        output: SessionRenderOutput,
    ) -> PyResult<Py<PyDict>> {
        let timings = PyDict::new(py);
        // Warm path là 0; save-over được core đo đúng vào hai pha này.
        timings.set_item("open", duration_ms(output.timings.open))?;
        timings.set_item("parse", duration_ms(output.timings.parse))?;
        timings.set_item("resource", duration_ms(output.timings.resource))?;
        timings.set_item("raster", duration_ms(output.timings.raster))?;
        timings.set_item("color", duration_ms(output.timings.color))?;
        timings.set_item("encode", 0.0)?;

        let out = PyDict::new(py);
        out.set_item("width", output.width)?;
        out.set_item("height", output.height)?;
        out.set_item("rgb", PyBytes::new(py, &output.rgb))?;
        out.set_item("rotate", output.rotate)?;
        out.set_item("degraded", output.degraded)?;
        out.set_item("ink_unsound", output.ink_unsound)?;
        out.set_item("document_identity", output.identity)?;
        out.set_item("session_generation", output.session_generation)?;
        out.set_item("request_generation", request_generation)?;
        out.set_item(
            "resource_cache_hit",
            output.stats_after.image_hits > output.stats_before.image_hits,
        )?;
        out.set_item("cache", cache_stats_dict(py, output.stats_after)?)?;
        out.set_item("timings_ms", timings)?;
        Ok(out.into())
    }
}

impl Drop for PpeRenderSession {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.latest_request_generation
            .store(u64::MAX, Ordering::Release);
        if let Ok(active) = self.active_cancel.lock() {
            if let Some((_, token)) = active.as_ref() {
                token.cancel();
            }
        }
        if let Ok(mut session) = self.inner.try_lock() {
            session.close();
        }
    }
}

fn cache_stats_dict(py: Python<'_>, stats: ResourceCacheStats) -> PyResult<Py<PyDict>> {
    let out = PyDict::new(py);
    out.set_item("image_hits", stats.image_hits)?;
    out.set_item("image_misses", stats.image_misses)?;
    out.set_item("image_evictions", stats.image_evictions)?;
    out.set_item("page_hits", stats.page_hits)?;
    out.set_item("page_misses", stats.page_misses)?;
    out.set_item("bytes", stats.bytes)?;
    out.set_item("budget_bytes", stats.budget_bytes)?;
    Ok(out.into())
}

#[cfg(test)]
mod active_cancel_tests {
    use super::*;

    #[test]
    fn newer_generation_cancels_and_replaces_older_generation() {
        let slot = Mutex::new(None);
        let older = CancelToken::new();
        let newer = CancelToken::new();
        install_cancel_token_in_slot(&slot, 1, older.clone()).unwrap();
        install_cancel_token_in_slot(&slot, 2, newer.clone()).unwrap();

        assert!(older.is_cancelled());
        assert!(!newer.is_cancelled());
        assert_eq!(slot.lock().unwrap().as_ref().map(|item| item.0), Some(2));
    }

    #[test]
    fn late_older_generation_cannot_replace_newer_generation() {
        let slot = Mutex::new(None);
        let newer = CancelToken::new();
        let late_older = CancelToken::new();
        install_cancel_token_in_slot(&slot, 2, newer.clone()).unwrap();
        install_cancel_token_in_slot(&slot, 1, late_older.clone()).unwrap();

        assert!(late_older.is_cancelled());
        assert!(!newer.is_cancelled());
        assert_eq!(slot.lock().unwrap().as_ref().map(|item| item.0), Some(2));
    }

    #[test]
    fn cancel_through_is_bounded_and_idempotent() {
        let slot = Mutex::new(None);
        let token = CancelToken::new();
        install_cancel_token_in_slot(&slot, 2, token.clone()).unwrap();

        assert!(!cancel_active_through_in_slot(&slot, 1).unwrap());
        assert!(!token.is_cancelled());
        assert!(cancel_active_through_in_slot(&slot, 2).unwrap());
        assert!(!cancel_active_through_in_slot(&slot, 2).unwrap());
    }

    #[test]
    fn old_guard_cannot_clear_newer_generation() {
        let slot = Mutex::new(None);
        install_cancel_token_in_slot(&slot, 2, CancelToken::new()).unwrap();

        clear_active_generation_in_slot(&slot, 1);

        assert_eq!(slot.lock().unwrap().as_ref().map(|item| item.0), Some(2));
        clear_active_generation_in_slot(&slot, 2);
        assert!(slot.lock().unwrap().is_none());
    }
}

/// Tách kẽm một trang bằng PPE.
///
/// * `ink_accurate = true` → đo lượng mực DeviceCMYK: không khử răng cưa. Dùng
///   cho TAC / ink-limit. Vùng đặc đọc đúng 100% mực mỗi kênh.
/// * `ink_accurate = false` → đường xem trước, có khử răng cưa.
/// * `cmyk_profile` → bật quản lý màu ICC (thường là FOGRA39.icc).
/// * `rgb_profile` → profile RGB nguồn cho `DeviceRGB`; bỏ trống thì dùng sRGB.
/// * `render_intent` → 0 perceptual, 1 relative, 2 saturation, 3 absolute.
/// * `fallback_font` → file TrueType dùng thay khi PDF **không nhúng** font.
///
/// # Vì sao `fallback_font` là đường dẫn do Python truyền vào
///
/// Không hardcode trong Rust: layout thư mục assets do lớp đóng gói quyết định
/// (dev chạy từ repo, bản phát hành nằm trong sidecar), nên chỉ Python biết font
/// thật ở đâu. Truyền `None` là lựa chọn trung thực nhất nhưng để lại lỗ đo —
/// trang toàn chữ không nhúng font sẽ báo **0% mực**, tức báo *thiếu* mực, đúng
/// chiều sai làm hỏng lô in.
///
/// Trả dict với `plates[i]["ink"]` là `bytes` dài `width * height`.
#[pyfunction]
#[pyo3(signature = (
    pdf_path,
    page = 1,
    dpi = 100.0,
    ink_accurate = false,
    page_box = "crop",
    cmyk_profile = None,
    rgb_profile = None,
    render_intent = 1,
    fallback_font = None,
    memory_budget_mb = 512,
    output_preview_filter = "all",
))]
#[allow(clippy::too_many_arguments)]
pub fn ppe_separations(
    py: Python<'_>,
    pdf_path: &str,
    page: usize,
    dpi: f32,
    ink_accurate: bool,
    page_box: &str,
    cmyk_profile: Option<&str>,
    rgb_profile: Option<&str>,
    render_intent: i32,
    fallback_font: Option<&str>,
    memory_budget_mb: usize,
    output_preview_filter: &str,
) -> PyResult<Py<PyDict>> {
    if page == 0 {
        return Err(PyValueError::new_err(
            "page là chỉ số 1-based, không nhận 0",
        ));
    }
    let which_box = match page_box {
        "media" => PageBox::Media,
        "crop" => PageBox::Crop,
        "trim" => PageBox::Trim,
        "bleed" => PageBox::Bleed,
        "art" => PageBox::Art,
        other => {
            return Err(PyValueError::new_err(format!(
                "page_box không hợp lệ: {other} (media|crop|trim|bleed|art)"
            )))
        }
    };
    let output_preview_filter = output_preview_filter_from_str(output_preview_filter)?;
    let base_opts = if ink_accurate {
        RenderOptions::ink_accurate()
    } else {
        // COLOR (audit 2026-08-10 §OP.1): vẫn giữ từng kênh spot riêng, nhưng lấy
        // thêm LUT tint → CMYK trong cùng lần raster để ghép subset kẽm qua ICC mà
        // không phải parse/render lại PDF. `flatten_spots` chỉ có hiệu lực lúc xuất
        // ảnh; byte từng plate ở dưới vẫn là lượng mực nguyên bản.
        RenderOptions::softproof()
    };
    // CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.4): lọc ngay lúc dựng
    // InkBuffer, nên plate/TAC dùng đúng cùng tập object với bitmap soft-proof.
    let base_opts = base_opts.with_output_preview_filter(output_preview_filter);
    let memory_budget_bytes = memory_budget_mb
        .checked_mul(1024 * 1024)
        .filter(|bytes| *bytes > 0)
        .ok_or_else(|| PyValueError::new_err("memory_budget_mb must be greater than zero"))?;
    let base_opts = base_opts.with_memory_budget_bytes(memory_budget_bytes);

    // Đọc font ngay ở đây để đường dẫn sai **nổ** thành lỗi Python, thay vì lặng
    // lẽ chạy tiếp ở chế độ không-fallback. Bỏ qua âm thầm sẽ cho ra một trang
    // chữ báo 0% mực mà không có dấu hiệu nào cho biết vì sao.
    let opts = match fallback_font {
        Some(path) => {
            let data = std::fs::read(path).map_err(|e| {
                PyRuntimeError::new_err(format!("không đọc được fallback_font {path}: {e}"))
            })?;
            base_opts.with_fallback_font(std::sync::Arc::new(data))
        }
        None => base_opts,
    };

    let intent = RenderIntent::from_pdf(render_intent);

    // Render là việc nặng và không chạm Python object nào → nhả GIL để backend
    // vẫn phục vụ request khác. Đây là khác biệt lớn so với gọi Ghostscript qua
    // subprocess: không có tiến trình con, không có cửa sổ console, không temp file.
    //
    // `ColorManager` được dựng **bên trong** closure, không dựng trước rồi truyền
    // vào: nó giữ cache LUT bằng `RefCell` nên không `Sync`, mà `allow_threads`
    // đòi closure không mang theo dữ liệu chia sẻ được. Không mất gì vì LUT vốn
    // dựng lười — chi phí đúng bằng lần dùng đầu tiên.
    //
    // Lưu ý quan trọng: nạp profile **không** làm đổi kết quả của nội dung
    // DeviceCMYK — giá trị CMYK trong file chính là lượng mực và không bao giờ
    // được round-trip qua ICC. Profile chỉ áp cho DeviceRGB / Lab / ICCBased.
    // Nhờ vậy `ink_accurate` vẫn cho vùng đặc đúng 400% dù đã bật ICC.
    let rendered = py
        .detach(|| {
            let manager = match cmyk_profile {
                Some(path) => Some(ColorManager::from_profiles(
                    Path::new(path),
                    rgb_profile.map(Path::new),
                    intent,
                )?),
                None => None,
            };
            let doc = ppe_open(pdf_path)?;
            render_page_managed(&doc, page, dpi, which_box, opts, manager.as_ref())
        })
        .map_err(|e| PyRuntimeError::new_err(format!("PPE: {e}")))?;

    let buffer = &rendered.buffer;
    let warnings = &rendered.warnings;

    let plates = PyList::empty(py);
    for (ch, colorant) in buffer.space().colorants().iter().enumerate() {
        let plate = PyDict::new(py);
        plate.set_item("name", colorant.name())?;
        plate.set_item("is_spot", colorant.is_spot())?;
        plate.set_item("ink", PyBytes::new(py, &buffer.plate_u8(ch)))?;
        plate.set_item("coverage_pct", buffer.plate_coverage_pct(ch))?;
        if let Some(alternate) = buffer.space().spot_alternate(ch) {
            let lut = PyList::empty(py);
            for sample in alternate.samples() {
                lut.append(sample.to_vec())?;
            }
            plate.set_item("alternate_cmyk_lut", lut)?;
        }
        plates.append(plate)?;
    }

    let skipped = PyList::empty(py);
    for (op, count) in &warnings.skipped_ops {
        let entry = PyDict::new(py);
        entry.set_item("op", op)?;
        entry.set_item("count", *count)?;
        skipped.append(entry)?;
    }

    let out = PyDict::new(py);
    out.set_item("engine", "ppe")?;
    out.set_item("width", buffer.width())?;
    out.set_item("height", buffer.height())?;
    out.set_item("rotate", rendered.rotate)?;
    out.set_item("max_tac_pct", buffer.max_tac_percent())?;
    out.set_item("plates", plates)?;
    // `degraded = true` nghĩa là trang có thứ PPE chưa vẽ đúng ⇒ lớp Python PHẢI
    // hạ `accuracy` và KHÔNG được kết luận "đạt ngưỡng mực".
    //
    // Giữ `degraded` (hợp của hai trục) để contract cũ không vỡ, nhưng phơi thêm
    // hai trục riêng vì chúng dẫn tới quyết định KHÁC NHAU:
    //
    // * `ink_unsound` — lượng mực không đáng tin (thiếu object / transparency chưa
    //   dựng / màu xấp xỉ / nội dung có thể đang bị ẩn). Cấm chốt kẽm.
    // * `geometry_approximate` — chữ ĐÃ lên mực nhưng hình khác bản gốc (font thay
    //   thế). Đỉnh mực vùng đặc vẫn đúng, chỉ % diện tích phủ là ước lượng.
    //
    // Gộp hai thứ này vào một cờ khiến gần như mọi file xưởng thật bị hạ tin cậy
    // (file nào cũng có chữ) — cảnh báo báo oan rồi cũng bị bỏ qua như không có.
    out.set_item("degraded", warnings.degrades_accuracy())?;
    out.set_item("ink_unsound", warnings.ink_unsound())?;
    out.set_item("geometry_approximate", warnings.geometry_approximate())?;
    out.set_item("substituted_fonts", warnings.substituted_fonts.clone())?;
    out.set_item("hidden_content_risk", warnings.hidden_content_risk)?;
    out.set_item("dropped_objects", warnings.dropped_objects)?;
    out.set_item(
        "unsupported_transparency",
        warnings.unsupported_transparency,
    )?;
    out.set_item(
        "approximated_colorspaces",
        warnings.approximated_colorspaces.clone(),
    )?;
    out.set_item("colorspaces_used", warnings.colorspaces_used.clone())?;
    out.set_item("color_managed", cmyk_profile.is_some())?;
    out.set_item("skipped_ops", skipped)?;
    Ok(out.into())
}

struct SeparationCompositePlate {
    name: String,
    ink: Vec<u8>,
    is_spot: bool,
    alternate: Option<SpotAlternate>,
}

fn required_plate_item<'py>(
    plate: &'py Bound<'py, PyDict>,
    key: &str,
) -> PyResult<Bound<'py, PyAny>> {
    plate
        .get_item(key)?
        .ok_or_else(|| PyValueError::new_err(format!("plate thiếu trường bắt buộc '{key}'")))
}

fn parse_separation_composite_plates(
    plates: &Bound<'_, PyList>,
    pixel_count: usize,
) -> PyResult<Vec<SeparationCompositePlate>> {
    if plates.len() == 0 || plates.len() > 64 {
        return Err(PyValueError::new_err("plates phải có từ 1 đến 64 bản kẽm"));
    }
    let mut names = HashSet::with_capacity(plates.len());
    let mut parsed = Vec::with_capacity(plates.len());
    for item in plates.iter() {
        let plate = item.cast::<PyDict>()?;
        let name: String = required_plate_item(plate, "name")?.extract()?;
        if name.is_empty() || !names.insert(name.clone()) {
            return Err(PyValueError::new_err(format!(
                "tên bản kẽm rỗng hoặc bị trùng: '{name}'"
            )));
        }
        let ink: Vec<u8> = required_plate_item(plate, "ink")?.extract()?;
        if ink.len() != pixel_count {
            return Err(PyValueError::new_err(format!(
                "bản kẽm '{name}' có {} byte, cần đúng {pixel_count}",
                ink.len()
            )));
        }
        let is_spot = plate
            .get_item("is_spot")?
            .and_then(|value| value.extract::<bool>().ok())
            .unwrap_or(false);
        let alternate = match plate.get_item("alternate_cmyk_lut")? {
            Some(value) if !value.is_none() => {
                let samples: Vec<Vec<f32>> = value.extract()?;
                let mut lut = Vec::with_capacity(samples.len());
                for sample in samples {
                    if sample.len() != 4 || sample.iter().any(|channel| !channel.is_finite()) {
                        return Err(PyValueError::new_err(format!(
                            "LUT CMYK của bản kẽm '{name}' không hợp lệ"
                        )));
                    }
                    lut.push([sample[0], sample[1], sample[2], sample[3]]);
                }
                Some(SpotAlternate::from_lut(lut).ok_or_else(|| {
                    PyValueError::new_err(format!(
                        "LUT CMYK của bản kẽm '{name}' phải có đúng {} mẫu",
                        SpotAlternate::lut_steps()
                    ))
                })?)
            }
            _ => None,
        };
        parsed.push(SeparationCompositePlate {
            name,
            ink,
            is_spot,
            alternate,
        });
    }
    Ok(parsed)
}

fn process_plate_channel(name: &str) -> Option<usize> {
    match name {
        "Cyan" => Some(0),
        "Magenta" => Some(1),
        "Yellow" => Some(2),
        "Black" => Some(3),
        _ => None,
    }
}

/// Ghép lại tập bản kẽm đã chọn từ byte lượng mực có sẵn rồi đổi một lần qua ICC.
///
/// PERF/COLOR (audit 2026-08-10 §OP.1): thao tác này không mở PDF, không chạy
/// content interpreter và không raster lại trang. Vì vậy click/solo kẽm chỉ còn
/// chi phí giải nén ở facade + cộng mặt phẳng mực + CMM, thay cho một lần render
/// PPE đầy đủ hoặc lớp `mix-blend-multiply` sai màu.
#[pyfunction]
#[pyo3(signature = (
    width,
    height,
    plates,
    enabled_names,
    cmyk_profile,
    rgb_profile = None,
    render_intent = 1,
    memory_budget_mb = 512,
))]
#[allow(clippy::too_many_arguments)]
pub fn ppe_compose_separation_subset(
    py: Python<'_>,
    width: u32,
    height: u32,
    plates: &Bound<'_, PyList>,
    enabled_names: Vec<String>,
    cmyk_profile: &str,
    rgb_profile: Option<&str>,
    render_intent: i32,
    memory_budget_mb: usize,
) -> PyResult<Py<PyDict>> {
    if width == 0 || height == 0 {
        return Err(PyValueError::new_err("width/height phải lớn hơn 0"));
    }
    if cmyk_profile.is_empty() {
        return Err(PyValueError::new_err(
            "ghép bản kẽm cần cmyk_profile để quản lý màu",
        ));
    }
    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| PyValueError::new_err("kích thước ảnh bản kẽm bị tràn số"))?;
    let budget_bytes = megabytes_to_bytes(memory_budget_mb, "memory_budget_mb", false)?;
    let bytes_per_pixel = std::mem::size_of::<[f32; 4]>()
        .checked_add(3)
        .and_then(|base| base.checked_add(plates.len()))
        .ok_or_else(|| PyValueError::new_err("bộ nhớ ghép bản kẽm bị tràn số"))?;
    let working_bytes = pixel_count
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| PyValueError::new_err("bộ nhớ ghép bản kẽm bị tràn số"))?;
    if working_bytes > budget_bytes {
        return Err(PyValueError::new_err(format!(
            "ghép bản kẽm cần khoảng {} MB, vượt ngân sách {memory_budget_mb} MB",
            working_bytes.div_ceil(1024 * 1024)
        )));
    }

    let parsed = parse_separation_composite_plates(plates, pixel_count)?;
    let available: HashSet<&str> = parsed.iter().map(|plate| plate.name.as_str()).collect();
    let enabled: HashSet<String> = enabled_names.into_iter().collect();
    if let Some(unknown) = enabled
        .iter()
        .find(|name| !available.contains(name.as_str()))
    {
        return Err(PyValueError::new_err(format!(
            "bản kẽm được chọn không tồn tại: '{unknown}'"
        )));
    }

    let mut process: [Option<Vec<u8>>; 4] = [None, None, None, None];
    let mut spots: Vec<(String, Vec<u8>, Option<SpotAlternate>)> = Vec::new();
    for plate in parsed {
        if !enabled.contains(&plate.name) {
            continue;
        }
        if plate.is_spot {
            spots.push((plate.name, plate.ink, plate.alternate));
        } else if let Some(channel) = process_plate_channel(&plate.name) {
            if process[channel].replace(plate.ink).is_some() {
                return Err(PyValueError::new_err(format!(
                    "bản kẽm process bị trùng kênh: '{}'",
                    plate.name
                )));
            }
        } else {
            return Err(PyValueError::new_err(format!(
                "bản kẽm process không được nhận diện: '{}'",
                plate.name
            )));
        }
    }
    let missing_spot_alternates: Vec<String> = spots
        .iter()
        .filter(|(_, _, alternate)| alternate.is_none())
        .map(|(name, _, _)| name.clone())
        .collect();
    let cmyk_profile = cmyk_profile.to_owned();
    let rgb_profile = rgb_profile.map(str::to_owned);
    let intent = RenderIntent::from_pdf(render_intent);

    let rgb = py
        .detach(move || -> print_engine::error::PpeResult<Vec<u8>> {
            let cmyk: Vec<[f32; 4]> = (0..pixel_count)
                .into_par_iter()
                .map(|index| {
                    let mut pixel = [0.0f32; 4];
                    for channel in 0..4 {
                        if let Some(plane) = &process[channel] {
                            pixel[channel] = plane[index] as f32 / 255.0;
                        }
                    }
                    for (_, plane, alternate) in &spots {
                        let tint = plane[index] as f32 / 255.0;
                        if tint <= 0.0 {
                            continue;
                        }
                        match alternate {
                            Some(alternate) => {
                                let addition = alternate.cmyk_at(tint);
                                for channel in 0..4 {
                                    pixel[channel] = (pixel[channel] + addition[channel]).min(1.0);
                                }
                            }
                            None => pixel[3] = (pixel[3] + tint).min(1.0),
                        }
                    }
                    pixel
                })
                .collect();
            let manager = ColorManager::from_profiles(
                Path::new(&cmyk_profile),
                rgb_profile.as_deref().map(Path::new),
                intent,
            )?;
            let converted = manager.cmyk_to_srgb_batch(&cmyk).ok_or_else(|| {
                PpeError::Unsupported("không quy được tập bản kẽm sang sRGB".into())
            })?;
            let mut flat = Vec::with_capacity(pixel_count * 3);
            for pixel in converted {
                flat.extend_from_slice(&pixel);
            }
            Ok(flat)
        })
        .map_err(|error| PyRuntimeError::new_err(format!("PPE: {error}")))?;

    let out = PyDict::new(py);
    out.set_item("width", width)?;
    out.set_item("height", height)?;
    out.set_item("rgb", PyBytes::new(py, &rgb))?;
    out.set_item("color_managed", true)?;
    out.set_item("missing_spot_alternates", missing_spot_alternates)?;
    Ok(out.into())
}

/// Năng lực hiện tại của PPE — nguồn duy nhất cho capability matrix ở lớp Python.
///
/// Soft-proof một trang: render trong không gian mực rồi quy sang sRGB qua ICC.
///
/// Trả `(width, height, rgb_bytes, degraded, ink_unsound)` — `rgb_bytes` dài
/// `width * height * 3`.
///
/// # Khác `ppe_separations` ở hai điểm, và cả hai là có chủ ý
///
/// 1. **Khử răng cưa bật.** Đây là đường để *xem*, không phải để *đo*.
/// 2. **Mực pha được quy về CMYK** qua tint transform. Màn hình không có mực pha; giữ
///    kênh riêng rồi chỉ đọc bốn kênh process sẽ làm một trang chỉ dùng Pantone hiện
///    ra trắng.
///
/// Vì lý do (1) và (2), kết quả của hàm này **không được** dùng để kết luận về lượng
/// mực. Đó là lý do nó là một hàm riêng chứ không phải một cờ của `ppe_separations`.
///
/// `cmyk_profile` là **bắt buộc**: không có profile thì "soft-proof" chỉ là một công
/// thức đoán, và hứa một thứ không có là tệ hơn không hứa.
#[pyfunction]
#[pyo3(signature = (
    pdf_path,
    page = 1,
    dpi = 150.0,
    cmyk_profile = "",
    rgb_profile = None,
    render_intent = 1,
    page_box = "crop",
    fallback_font = None,
    simulate_overprint = true,
    output_preview_filter = "all",
    simulate_paper_color = false,
    simulate_black_ink = false,
    page_background_rgb = None,
    memory_budget_mb = 512,
    clip_x = None,
    clip_y = None,
    clip_width = None,
    clip_height = None,
    optional_content_usage = "print",
    render_annotations = false,
))]
#[allow(clippy::too_many_arguments)]
pub fn ppe_softproof(
    py: Python<'_>,
    pdf_path: &str,
    page: usize,
    dpi: f32,
    cmyk_profile: &str,
    rgb_profile: Option<&str>,
    render_intent: i32,
    page_box: &str,
    fallback_font: Option<&str>,
    simulate_overprint: bool,
    output_preview_filter: &str,
    simulate_paper_color: bool,
    simulate_black_ink: bool,
    page_background_rgb: Option<(u8, u8, u8)>,
    memory_budget_mb: usize,
    clip_x: Option<u32>,
    clip_y: Option<u32>,
    clip_width: Option<u32>,
    clip_height: Option<u32>,
    optional_content_usage: &str,
    render_annotations: bool,
) -> PyResult<Py<PyDict>> {
    if page == 0 {
        return Err(PyValueError::new_err(
            "page là chỉ số 1-based, không nhận 0",
        ));
    }
    if cmyk_profile.is_empty() {
        return Err(PyValueError::new_err(
            "soft-proof cần cmyk_profile; không có profile thì không có soft-proof",
        ));
    }
    let which_box = match page_box {
        "media" => PageBox::Media,
        "crop" => PageBox::Crop,
        "trim" => PageBox::Trim,
        "bleed" => PageBox::Bleed,
        "art" => PageBox::Art,
        other => {
            return Err(PyValueError::new_err(format!(
                "page_box không hợp lệ: {other}"
            )))
        }
    };
    let memory_budget_bytes = memory_budget_mb
        .checked_mul(1024 * 1024)
        .filter(|bytes| *bytes > 0)
        .ok_or_else(|| PyValueError::new_err("memory_budget_mb must be greater than zero"))?;
    let output_preview_filter = output_preview_filter_from_str(output_preview_filter)?;
    let optional_content_usage = optional_content_usage_from_str(optional_content_usage)?;
    let proof_settings = softproof_settings(
        simulate_paper_color,
        simulate_black_ink,
        page_background_rgb,
    );
    // CORRECTNESS (audit 2026-08-31 §LÔ-B): stateless và session phải dùng
    // cùng policy OCG/annotation để HTTP fallback không đổi artifact Viewer.
    let base_opts = RenderOptions::softproof()
        .with_optional_content_usage(optional_content_usage)
        .with_annotations(render_annotations)
        .with_overprint_simulation(simulate_overprint)
        .with_output_preview_filter(output_preview_filter)
        .with_softproof_settings(proof_settings)
        .with_memory_budget_bytes(memory_budget_bytes);
    let opts = match fallback_font {
        Some(path) => {
            let data = std::fs::read(path).map_err(|e| {
                PyRuntimeError::new_err(format!("không đọc được fallback_font {path}: {e}"))
            })?;
            base_opts.with_fallback_font(std::sync::Arc::new(data))
        }
        None => base_opts,
    };
    let intent = RenderIntent::from_pdf(render_intent);
    let clip = match (clip_x, clip_y, clip_width, clip_height) {
        (None, None, None, None) => None,
        (Some(x), Some(y), Some(width), Some(height)) => Some(RasterClip {
            x,
            y,
            width,
            height,
        }),
        _ => {
            return Err(PyValueError::new_err(
                "clip PPE phải truyền đủ x/y/width/height",
            ))
        }
    };

    let (width, height, rgb, degraded, ink_unsound) = py
        .detach(|| -> print_engine::error::PpeResult<_> {
            let manager = ColorManager::from_profiles(
                Path::new(cmyk_profile),
                rgb_profile.map(Path::new),
                intent,
            )?;
            let doc = ppe_open(pdf_path)?;
            let rendered =
                render_page_managed_region(&doc, page, dpi, which_box, opts, Some(&manager), clip)?;
            let rgb = rendered
                .buffer
                .to_srgb_with_cancel_and_settings(&manager, None, proof_settings)?
                .ok_or_else(|| {
                    print_engine::error::PpeError::Unsupported(
                        "không quy được mực sang sRGB".to_string(),
                    )
                })?;
            Ok((
                rendered.buffer.width(),
                rendered.buffer.height(),
                rgb,
                rendered.warnings.degrades_accuracy(),
                rendered.warnings.ink_unsound(),
            ))
        })
        .map_err(|e| PyRuntimeError::new_err(format!("PPE: {e}")))?;

    let out = PyDict::new(py);
    out.set_item("width", width)?;
    out.set_item("height", height)?;
    out.set_item("rgb", PyBytes::new(py, &rgb))?;
    out.set_item("degraded", degraded)?;
    // Trả cả cờ này dù đây là đường xem: một trang mà engine chưa vẽ đủ thì ảnh
    // soft-proof cũng thiếu nội dung, và lớp UI cần nói ra chứ không im lặng.
    out.set_item("ink_unsound", ink_unsound)?;
    Ok(out.into())
}

/// Export CMYK production: render trang trong không gian mực, gộp spot vào
/// process CMYK, trả dữ liệu 4 kênh 8 bit (interleaved).
///
/// Khác `ppe_softproof` ở chỗ KHÔNG quy sang RGB — giữ nguyên CMYK cho
/// downstream (TIFF CMYK, imposition, RIP). Caller tự nhúng ICC profile
/// (FOGRA39/SWOP) khi ghi file.
///
/// `cmyk_profile` vẫn bắt buộc: PPE cần profile CMYK để phân giải ICC-based
/// color space trong PDF (CalCMYK, ICCBased 4-channel). Nếu PDF chỉ dùng
/// DeviceCMYK thuần thì profile không ảnh hưởng giá trị kênh.
#[pyfunction]
#[pyo3(signature = (
    pdf_path,
    page = 1,
    dpi = 300.0,
    cmyk_profile = "",
    render_intent = 1,
    page_box = "crop",
    fallback_font = None,
    simulate_overprint = true,
    memory_budget_mb = 512,
))]
#[allow(clippy::too_many_arguments)]
pub fn ppe_export_cmyk(
    py: Python<'_>,
    pdf_path: &str,
    page: usize,
    dpi: f32,
    cmyk_profile: &str,
    render_intent: i32,
    page_box: &str,
    fallback_font: Option<&str>,
    simulate_overprint: bool,
    memory_budget_mb: usize,
) -> PyResult<Py<PyDict>> {
    if page == 0 {
        return Err(PyValueError::new_err(
            "page là chỉ số 1-based, không nhận 0",
        ));
    }
    if cmyk_profile.is_empty() {
        return Err(PyValueError::new_err(
            "export CMYK cần cmyk_profile để phân giải ICC color space trong PDF",
        ));
    }
    let which_box = match page_box {
        "media" => PageBox::Media,
        "crop" => PageBox::Crop,
        "trim" => PageBox::Trim,
        "bleed" => PageBox::Bleed,
        "art" => PageBox::Art,
        other => {
            return Err(PyValueError::new_err(format!(
                "page_box không hợp lệ: {other}"
            )))
        }
    };
    let memory_budget_bytes = memory_budget_mb
        .checked_mul(1024 * 1024)
        .filter(|bytes| *bytes > 0)
        .ok_or_else(|| PyValueError::new_err("memory_budget_mb must be greater than zero"))?;
    // PERF (audit 2026-07-30 lô 4): production CMYK không cần anti-alias (RIP xử lý),
    // dùng ink_accurate() (AA tắt) + flatten_spots thay vì softproof() (AA bật).
    // Tiết kiệm ~30-50% thời gian render.
    let mut base_opts = RenderOptions::ink_accurate()
        .with_overprint_simulation(simulate_overprint)
        .with_memory_budget_bytes(memory_budget_bytes);
    base_opts.flatten_spots = true;
    let opts = match fallback_font {
        Some(path) => {
            let data = std::fs::read(path).map_err(|e| {
                PyRuntimeError::new_err(format!("không đọc được fallback_font {path}: {e}"))
            })?;
            base_opts.with_fallback_font(std::sync::Arc::new(data))
        }
        None => base_opts,
    };
    let intent = RenderIntent::from_pdf(render_intent);

    let (width, height, cmyk_bytes, degraded, ink_unsound) = py
        .detach(|| -> print_engine::error::PpeResult<_> {
            let manager = ColorManager::from_profiles(
                Path::new(cmyk_profile),
                None::<&Path>, // Không cần RGB profile — giữ CMYK
                intent,
            )?;
            let doc = ppe_open(pdf_path)?;
            let rendered = render_page_managed(&doc, page, dpi, which_box, opts, Some(&manager))?;
            let cmyk = rendered.buffer.to_process_cmyk();
            Ok((
                rendered.buffer.width(),
                rendered.buffer.height(),
                cmyk,
                rendered.warnings.degrades_accuracy(),
                rendered.warnings.ink_unsound(),
            ))
        })
        .map_err(|e| PyRuntimeError::new_err(format!("PPE: {e}")))?;

    let out = PyDict::new(py);
    out.set_item("width", width)?;
    out.set_item("height", height)?;
    out.set_item("cmyk", PyBytes::new(py, &cmyk_bytes))?;
    out.set_item("degraded", degraded)?;
    out.set_item("ink_unsound", ink_unsound)?;
    Ok(out.into())
}

/// Để ở Rust (cạnh code thật) thay vì hardcode trong Python: khi một tính năng
/// được hoàn thiện, cờ đổi cùng lúc với code, không thể quên cập nhật.
/// Lấy đường viền chữ của một trang để Python ghi lại thành PDF (`OUTLINE_FONTS`).
///
/// # Phân chia trách nhiệm
///
/// Rust lo **font / encoding / ma trận chữ** — ba thứ đã được đo song song với
/// Ghostscript qua bộ golden. Python lo **ghi PDF** bằng pikepdf, thứ Rust không
/// có. Bản Python trước đây viết lại phần của Rust bằng fontTools và vấp đúng ở đó
/// (tra glyph thất bại, Type3 chưa đụng tới) — xem kế hoạch §19.7.
///
/// # Không gian toạ độ
///
/// `coords` nằm trong **không gian người dùng của content stream chứa chữ**: chỉ
/// ma trận chữ, KHÔNG có CTM của các lệnh `cm`. Python thay khối `BT … ET` tại chỗ
/// nên `cm` vẫn còn hiệu lực; nhân CTM vào đây là nhân hai lần.
///
/// # Contract trả về
///
/// ```text
/// {
///   "glyphs": [
///     { "stream": "page" | [obj, gen], "text_object_index": int,
///       "glyph_index": int, "fill": bool, "stroke": bool, "clip": bool,
///       "line_width": float, "verbs": bytes, "coords": [float, ...] }, ...
///   ],
///   "blocks": [                     # hợp đồng đồng bộ chỉ số theo SỐ LƯỢNG mã ký tự
///     { "stream": "page" | [obj, gen], "text_object_index": int,
///       "code_count": int }, ...    # đếm cả dấu cách và `Tr 3`
///   ],
///   "has_type3": bool,              # glyph là content stream ⇒ không outline được
///   "has_unsupported_context": bool # chữ trong soft mask / tiling pattern / form vô danh
///   "missing_glyphs": int,          # tra không ra đường viền ⇒ chữ sẽ MẤT
///   "complete": bool,               # ba cờ trên đều sạch
///   "substituted_fonts": [str],     # font không nhúng đã phải thay
/// }
/// ```
///
/// `verbs`: 0 = `m` (2 số), 1 = `l` (2 số), 2 = `c` (6 số), 3 = `h` (0 số).
/// Caller **phải** kiểm `complete` trước khi giao file ra: `False` nghĩa là có chữ
/// engine không chuyển được, và ghi tiếp sẽ tạo bản in thiếu chữ.
#[pyfunction]
#[pyo3(signature = (pdf_path, page = 1, fallback_font = None, memory_budget_mb = 512))]
pub fn ppe_text_outlines(
    py: Python<'_>,
    pdf_path: &str,
    page: usize,
    fallback_font: Option<&str>,
    memory_budget_mb: usize,
) -> PyResult<Py<PyDict>> {
    if page == 0 {
        return Err(PyValueError::new_err(
            "page là chỉ số 1-based, không nhận 0",
        ));
    }
    let memory_budget_bytes = memory_budget_mb
        .checked_mul(1024 * 1024)
        .filter(|bytes| *bytes > 0)
        .ok_or_else(|| PyValueError::new_err("memory_budget_mb must be greater than zero"))?;
    let base_opts =
        RenderOptions::collecting_text_outlines().with_memory_budget_bytes(memory_budget_bytes);
    let opts = match fallback_font {
        Some(path) => {
            let data = std::fs::read(path).map_err(|e| {
                PyRuntimeError::new_err(format!("không đọc được fallback_font {path}: {e}"))
            })?;
            base_opts.with_fallback_font(std::sync::Arc::new(data))
        }
        None => base_opts,
    };

    // 72 DPI: hình học trả về nằm trong không gian người dùng nên KHÔNG phụ thuộc
    // DPI. Dùng mức thấp nhất hợp lệ để buffer raster (thứ không ai đọc ở đường này)
    // không tốn bộ nhớ vô ích.
    let rendered = py
        .detach(|| {
            let doc = ppe_open(pdf_path)?;
            render_page_managed(&doc, page, 72.0, PageBox::Crop, opts, None)
        })
        .map_err(|e| PyRuntimeError::new_err(format!("PPE: {e}")))?;

    let report = &rendered.text_outlines;
    let glyphs = PyList::empty(py);
    for g in &report.glyphs {
        let item = PyDict::new(py);
        match g.stream {
            StreamKey::Page => item.set_item("stream", "page")?,
            StreamKey::Form(id, gen) => item.set_item("stream", (id, gen))?,
            // Đã bị chặn ở tầng engine, nhưng nếu lọt ra thì phải nói rõ chứ không
            // được gán nhầm cho stream của trang.
            StreamKey::Unaddressable => item.set_item("stream", "unaddressable")?,
        }
        item.set_item("text_object_index", g.text_object_index)?;
        item.set_item("glyph_index", g.glyph_index)?;
        item.set_item("fill", g.fill)?;
        item.set_item("stroke", g.stroke)?;
        item.set_item("clip", g.clip)?;
        item.set_item("line_width", g.line_width)?;
        item.set_item("verbs", PyBytes::new(py, &g.verbs))?;
        item.set_item("coords", g.coords.clone())?;
        glyphs.append(item)?;
    }

    // Số mã ký tự của từng khối `BT … ET`. Đây là hợp đồng để lớp ghi PDF đối chiếu
    // bằng SỐ LƯỢNG: khớp số ⇒ chỉ số hai bên khớp theo cấu trúc, không phụ thuộc
    // glyph to hay nhỏ (chốt hình học cũ bỏ sót dấu chấm 12pt vì nó chỉ 9 px mực).
    let blocks = PyList::empty(py);
    for b in &report.blocks {
        let item = PyDict::new(py);
        match b.stream {
            StreamKey::Page => item.set_item("stream", "page")?,
            StreamKey::Form(id, gen) => item.set_item("stream", (id, gen))?,
            StreamKey::Unaddressable => item.set_item("stream", "unaddressable")?,
        }
        item.set_item("text_object_index", b.text_object_index)?;
        item.set_item("code_count", b.code_count)?;
        blocks.append(item)?;
    }

    let out = PyDict::new(py);
    out.set_item("engine", "ppe")?;
    out.set_item("glyphs", glyphs)?;
    out.set_item("blocks", blocks)?;
    out.set_item("has_type3", report.has_type3)?;
    out.set_item("has_unsupported_context", report.has_unsupported_context)?;
    out.set_item("missing_glyphs", report.missing_glyphs)?;
    out.set_item("complete", report.is_complete())?;
    out.set_item(
        "substituted_fonts",
        rendered.warnings.substituted_fonts.clone(),
    )?;
    Ok(out.into())
}

#[pyfunction]
pub fn ppe_capabilities(py: Python<'_>) -> PyResult<Py<PyDict>> {
    let caps = PyDict::new(py);
    caps.set_item("version", env!("CARGO_PKG_VERSION"))?;
    // BUILD (audit 2026-08-10 §PPE.REAUDIT.7): version crate không đủ phân
    // biệt hai `.pyd` dựng từ source khác nhau. Các trường này do build.rs
    // nhúng và pipeline release đối chiếu lại trước khi đóng gói sidecar.
    caps.set_item("source_revision", env!("PRYNX_EMBED_SOURCE_REVISION"))?;
    caps.set_item("source_dirty", env!("PRYNX_EMBED_SOURCE_DIRTY") == "true")?;
    caps.set_item(
        "build_timestamp_utc",
        env!("PRYNX_EMBED_BUILD_TIMESTAMP_UTC"),
    )?;
    caps.set_item("build_profile", env!("PRYNX_EMBED_BUILD_PROFILE"))?;
    caps.set_item("build_provenance", env!("PRYNX_EMBED_BUILD_PROVENANCE"))?;
    caps.set_item("build_identity", env!("PRYNX_EMBED_BUILD_IDENTITY"))?;
    // Đây là mặc định của *binding* khi caller không truyền gì — KHÔNG phải chính
    // sách của sản phẩm. Backend chọn ngân sách theo RAM máy và số slot việc nặng
    // (`app/core/print_engine/facade.py::_auto_memory_budget_mb`); đọc con số này
    // như "PrynX chạy với 512 MiB" là hiểu sai, nên nói rõ chính sách ở khoá dưới.
    caps.set_item("memory_budget_default_mb", 512)?;
    caps.set_item(
        "memory_budget_policy",
        "caller-provided; backend: host-ram-aware",
    )?;
    caps.set_item("process_separations", true)?;
    caps.set_item("spot_separations", true)?;
    caps.set_item("separations_output_preview_filter", true)?;
    caps.set_item("separation_subset_composite", true)?;
    caps.set_item("overprint", true)?;
    caps.set_item("overprint_mode_1", true)?;
    caps.set_item("overprint_preview_toggle", true)?;
    caps.set_item("text_outlines", true)?;
    caps.set_item("tac", true)?;
    caps.set_item("vector_fill_stroke", true)?;
    caps.set_item("clipping", true)?;
    caps.set_item("form_xobject", true)?;
    caps.set_item("images", true)?;
    caps.set_item("image_mask_stencil", true)?;
    caps.set_item("image_soft_mask", true)?;
    // Codec ảnh khai riêng: "images = true" không có nghĩa mọi ảnh đều đọc được.
    // Gộp chung sẽ khiến lớp trên tin rằng một trang ảnh JPEG 2000 đã được vẽ.
    caps.set_item(
        "image_filters",
        vec![
            "FlateDecode",
            "LZWDecode",
            "ASCII85Decode",
            "ASCIIHexDecode",
            "RunLengthDecode",
            "DCTDecode",
            "CCITTFaxDecode",
        ],
    )?;
    caps.set_item("image_filters_missing", vec!["JPXDecode", "JBIG2Decode"])?;

    caps.set_item("icc_color_management", true)?;
    // ICC chỉ áp cho nội dung CHƯA phải mực. Dữ liệu đã là mực thì không bao giờ
    // round-trip: round-trip nén vùng đặc 400% xuống ~292% và biến một file vượt
    // giới hạn mực thành "đạt".
    caps.set_item("icc_applies_to", vec!["DeviceRGB", "Lab", "ICCBased"])?;
    caps.set_item(
        "icc_never_applies_to",
        vec!["DeviceCMYK", "DeviceGray", "Separation", "DeviceN"],
    )?;
    caps.set_item("soft_proof_cmyk_to_srgb", true)?;
    caps.set_item("render_session", true)?;
    caps.set_item("render_session_version", SESSION_ENGINE_VERSION)?;

    // Chữ: Type1 / CFF / TrueType / Type0-CID / Type3 → outline, có clip theo chữ.
    caps.set_item("text", true)?;
    caps.set_item(
        "text_font_formats",
        vec!["Type1", "Type1C/CFF", "TrueType", "Type0-CID", "Type3"],
    )?;
    // Font KHÔNG nhúng: engine chỉ vẽ được khi caller cấp `fallback_font`, và khi
    // đó hình chữ là xấp xỉ ⇒ bật `geometry_approximate`, KHÔNG bật `ink_unsound`.
    caps.set_item("text_substitute_font_requires_caller_asset", true)?;
    // Hai trục hỏng — lớp Python phải đọc đúng trục để không hạ tin cậy oan.
    caps.set_item("degraded_axes", vec!["ink_unsound", "geometry_approximate"])?;

    // Shading: kiểu 1/2/3 đã dựng, lưới 4–7 thì chưa. Khai riêng từng kiểu thay vì
    // một cờ `shading` duy nhất — "có shading" mà thực ra thiếu lưới Coons sẽ khiến
    // lớp trên tin rằng mọi trang gradient đều đo được.
    caps.set_item("shading", true)?;
    caps.set_item("shading_types", vec![1, 2, 3, 4, 5, 6, 7])?;
    caps.set_item("shading_types_missing", Vec::<i32>::new())?;
    caps.set_item("shading_pattern", true)?;
    caps.set_item("tiling_pattern", true)?;
    // Tiling pattern được vẽ thật (lặp lại ô mẫu), nhưng có trần số ô: vượt trần thì
    // báo thiếu tính năng chứ không vẽ một phần — vẽ một phần cho lượng mực thấp hơn
    // thực tế, đúng chiều sai nguy hiểm.
    caps.set_item("tiling_pattern_max_tiles", 1024)?;

    // Optional content: đọc theo cấu hình **in** (`/AS` + `/Usage /Print`), không
    // theo cấu hình xem. Một lớp hiện trên màn hình nhưng khai không-in thì KHÔNG
    // được tính mực.
    caps.set_item("optional_content", true)?;
    caps.set_item("optional_content_config", "print")?;
    caps.set_item("optional_content_configs", vec!["print", "view"])?;
    caps.set_item("inline_images", true)?;
    // Soft-proof: đường **xem**, khử răng cưa và quy mực pha về CMYK ⇒ tuyệt đối
    // không dùng kết quả của nó để kết luận lượng mực.
    caps.set_item("softproof", true)?;
    caps.set_item("softproof_requires_icc", true)?;
    caps.set_item("softproof_paper_color", true)?;
    caps.set_item("softproof_black_ink", true)?;
    // Capability của chính chữ ký binding, tách khỏi capability semantic core:
    // `.pyd` cũ biết View/annotation nhưng chưa chắc nhận được hai keyword này.
    caps.set_item("softproof_optional_content_usage_option", true)?;
    caps.set_item("softproof_render_annotations_option", true)?;
    caps.set_item("softproof_page_background", true)?;
    caps.set_item(
        "output_preview_filters",
        vec![
            "all",
            "device-cmyk",
            "device-rgb",
            "device-gray",
            "spot",
            "text",
            "images",
            "line-art",
            "smooth-shades",
        ],
    )?;
    // PERF (audit 2026-08-08 §RENDER.3): caller chỉ được truyền clip khi binding
    // công khai capability này; build cũ phải fail-fast thay vì fallback full-page.
    caps.set_item("softproof_viewport_clip", true)?;
    caps.set_item("annotation_appearance_stream", true)?;
    caps.set_item("annotation_dynamic_appearance", false)?;
    caps.set_item("annotation_xfa", false)?;

    // Trong suốt: blend mode và soft mask đã dựng; group đã dựng cả ba đường
    // (đục / không cách ly / cách ly). Riêng knockout group thì chưa — khai riêng
    // thay vì để `transparency_groups = true` che mất phần thiếu.
    caps.set_item("transparency_groups", true)?;
    caps.set_item("transparency_knockout_groups", false)?;
    caps.set_item("soft_mask", true)?;
    caps.set_item("soft_mask_types", vec!["Luminosity", "Alpha"])?;
    caps.set_item("blend_modes", true)?;
    // Bốn mode không tách kênh phải đi qua xấp xỉ RGB và **không** chạm kênh spot,
    // nên chúng không cùng mức tin cậy với mười một mode tách kênh.
    caps.set_item(
        "blend_modes_separable",
        vec![
            "Normal",
            "Multiply",
            "Screen",
            "Overlay",
            "Darken",
            "Lighten",
            "ColorDodge",
            "ColorBurn",
            "HardLight",
            "SoftLight",
            "Difference",
            "Exclusion",
        ],
    )?;
    caps.set_item(
        "blend_modes_approximated",
        vec!["Hue", "Saturation", "Color", "Luminosity"],
    )?;
    caps.set_item(
        "blend_modes_nonseparable_exact_in",
        vec!["DeviceRGB with ICC-managed RGB surface"],
    )?;
    caps.set_item(
        "blend_modes_nonseparable_compatibility_in",
        vec!["DeviceCMYK", "Other", "DeviceRGB without ICC"],
    )?;
    Ok(caps.into())
}
