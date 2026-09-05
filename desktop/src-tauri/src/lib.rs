use tauri::http::{self};
use tauri::Manager;

// Add state struct for PDFium
use image::ImageEncoder;
use pdfium_render::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(all(not(debug_assertions), target_os = "windows"))]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Response;
use tauri_plugin_fs::FsExt;

// `creation_flags` (ẩn cửa sổ console) đến từ trait CommandExt — chỉ cần ở các block
// bảo mật release-only trên Windows. Guard theo cfg để debug không cảnh báo unused.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
use std::os::windows::process::CommandExt;

mod device_identity;
mod document_window_registry;
mod external_app;
mod pdf_color_risk;
mod pdf_engine;
// [PROC-LIFECYCLE FIX 2026-08-28 §UP.7] Job Object để OS tự dọn tiến trình con.
pub(crate) mod process_guard;
mod security;
mod tile_disk_cache;

// Document Handle Pool - Capped to 1 to eliminate the massive
// sequential initialization overhead of `load_pdf_from_file` for large VDP files.
// Tile rendering is fast enough (10ms) that sequential Mutex rendering on 1 handle
// is orders of magnitude faster than initializing 8 handles (which takes 500ms each).
fn get_doc_pool_size() -> usize {
    1
}

// ═══ Disk tile cache (giống "display cache" của Acrobat/MuPDF) ═══
// Lưu tile đã render ra ĐĨA (thư mục temp — luôn ghi được kể cả bản đóng gói) để
// mở lại / cuộn lại / zoom về mức cũ là LẤY TỪ ĐĨA, không render lại (file nặng ~1s).
static DISK_CACHE_WRITES: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct PdfFileIdentity {
    size: u64,
    modified_nanos: u128,
    created_nanos: Option<u128>,
}

fn timestamp_nanos(timestamp: std::time::SystemTime, label: &str) -> Result<u128, String> {
    timestamp
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|_| format!("Mốc thời gian {label} của file PDF không hợp lệ."))
}

fn pdf_file_identity(file_path: &str) -> Result<PdfFileIdentity, String> {
    let metadata = std::fs::metadata(file_path)
        .map_err(|error| format!("Không đọc được thông tin file PDF: {error}"))?;
    if !metadata.is_file() {
        return Err("Đường dẫn PDF không phải là một file.".to_string());
    }

    let modified_nanos = timestamp_nanos(
        metadata
            .modified()
            .map_err(|error| format!("Không đọc được thời điểm sửa file PDF: {error}"))?,
        "chỉnh sửa",
    )?;
    let created_nanos = metadata
        .created()
        .ok()
        .and_then(|timestamp| timestamp_nanos(timestamp, "tạo").ok());

    Ok(PdfFileIdentity {
        size: metadata.len(),
        modified_nanos,
        created_nanos,
    })
}

fn pdf_file_identity_token(identity: PdfFileIdentity) -> String {
    // Chuỗi giữ nguyên nanosecond khi qua JSON/JavaScript; không dùng number vì vượt
    // giới hạn integer an toàn của JS và có thể làm pha metadata B nhận nhầm file mới.
    format!(
        "{}:{}:{}",
        identity.size,
        identity.modified_nanos,
        identity.created_nanos.unwrap_or(0)
    )
}

#[cfg(test)]
mod pdf_identity_tests {
    use super::*;

    #[test]
    fn token_identity_giu_nguyen_nanosecond_khi_qua_javascript() {
        let identity = PdfFileIdentity {
            size: 17_869_243,
            modified_nanos: 1_900_123_456_789_012_345,
            created_nanos: Some(1_800_987_654_321_098_765),
        };

        assert_eq!(
            pdf_file_identity_token(identity),
            "17869243:1900123456789012345:1800987654321098765"
        );
    }
}

#[cfg(test)]
mod viewer_metadata_benchmark_tests {
    use super::*;
    use std::time::Instant;

    fn close_benchmark_document(file_path: &str) {
        let removed = {
            let mut cache = lock_mutex(document_cache());
            cache.remove(file_path)
        };
        drop(removed);
    }

    fn read_metadata_dimensions(document: &CachedDocument, all_pages: bool) -> usize {
        let handle = document.pool[0].get().expect("PDF pool phải có handle");
        let _handle_guard = lock_mutex(&handle.lock);
        let _pdfium_guard = lock_mutex(&RENDER_LOCK);
        let pages = handle.doc.pages();
        let page_count = pages.len();
        let limit = if all_pages {
            page_count
        } else {
            page_count.min(1)
        };
        for page_index in 0..limit {
            pages.page_size(page_index).expect("đọc kích thước trang");
        }
        page_count as usize
    }

    #[test]
    #[ignore = "benchmark thủ công cần PRYNX_METADATA_BENCH_PDF và PDFium runtime"]
    fn benchmark_bootstrap_so_voi_metadata_day_du_tren_pdf_that() {
        let file_path = std::env::var("PRYNX_METADATA_BENCH_PDF")
            .expect("đặt PRYNX_METADATA_BENCH_PDF tới PDF cần đo");
        let pdfium = ensure_pdfium().expect("bind PDFium cho benchmark");
        let file_identity = pdf_file_identity(&file_path).expect("identity PDF benchmark");
        let mut bootstrap_samples = Vec::new();
        let mut background_samples = Vec::new();
        let mut legacy_samples = Vec::new();
        let mut page_count = 0;

        for _ in 0..5 {
            close_benchmark_document(&file_path);
            let started = Instant::now();
            let bootstrap =
                get_or_load_cached_document_with_identity(pdfium, &file_path, file_identity, false)
                    .expect("bootstrap document");
            page_count = read_metadata_dimensions(&bootstrap, false);
            bootstrap_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            let started = Instant::now();
            let (hydrated, _) =
                get_or_load_cached_document_with_color_risk(pdfium, &file_path, file_identity)
                    .expect("hydrate color risk");
            read_metadata_dimensions(&hydrated, true);
            background_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            close_benchmark_document(&file_path);
            let started = Instant::now();
            let legacy =
                get_or_load_cached_document_with_identity(pdfium, &file_path, file_identity, true)
                    .expect("legacy full metadata document");
            read_metadata_dimensions(&legacy, true);
            legacy_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        }
        close_benchmark_document(&file_path);

        bootstrap_samples.sort_by(f64::total_cmp);
        background_samples.sort_by(f64::total_cmp);
        legacy_samples.sort_by(f64::total_cmp);
        eprintln!(
            "METADATA_BENCH pages={} bootstrap_ms={:?} background_ms={:?} legacy_ms={:?} median_bootstrap_ms={:.2} median_legacy_ms={:.2}",
            page_count,
            bootstrap_samples,
            background_samples,
            legacy_samples,
            bootstrap_samples[2],
            legacy_samples[2],
        );
    }

    #[test]
    #[ignore = "artifact thủ công cần PRYNX_METADATA_BENCH_PDF và PDFium runtime"]
    fn tile_bon_goc_khop_anh_full_page_tren_pdf_that() {
        let file_path = std::env::var("PRYNX_METADATA_BENCH_PDF")
            .expect("đặt PRYNX_METADATA_BENCH_PDF tới PDF cần kiểm");
        let full_png = render_tile_png_in_process(&file_path, 1, 0.5, 0, None, None, None, None)
            .expect("render full page");
        let full = image::load_from_memory(&full_png)
            .expect("decode full page")
            .to_rgba8();
        let tile_size = 256_u32.min(full.width()).min(full.height());
        let corners = [
            (0, 0),
            (full.width() - tile_size, 0),
            (0, full.height() - tile_size),
            (full.width() - tile_size, full.height() - tile_size),
        ];

        for (clip_x, clip_y) in corners {
            let tile_png = render_tile_png_in_process(
                &file_path,
                1,
                0.5,
                0,
                Some(clip_x as i32),
                Some(clip_y as i32),
                Some(tile_size as i32),
                Some(tile_size as i32),
            )
            .expect("render viewport tile");
            let tile = image::load_from_memory(&tile_png)
                .expect("decode viewport tile")
                .to_rgba8();
            let expected =
                image::imageops::crop_imm(&full, clip_x, clip_y, tile_size, tile_size).to_image();
            assert_eq!(tile.dimensions(), expected.dimensions());
            // PDFium LCD text có thể lệch 1–2 mức kênh khi bitmap bắt đầu tại origin khác;
            // đo sai số ảnh thay vì đòi byte-identical để vẫn bắt lệch crop/hue thật.
            let mut absolute_sum = 0_u64;
            let mut max_channel_delta = 0_u8;
            let mut pixels_over_two = 0_usize;
            for (tile_pixel, expected_pixel) in tile.pixels().zip(expected.pixels()) {
                let mut pixel_max = 0_u8;
                for channel in 0..3 {
                    let delta = tile_pixel[channel].abs_diff(expected_pixel[channel]);
                    absolute_sum += u64::from(delta);
                    pixel_max = pixel_max.max(delta);
                    max_channel_delta = max_channel_delta.max(delta);
                }
                if pixel_max > 2 {
                    pixels_over_two += 1;
                }
            }
            let mae = absolute_sum as f64 / (tile.width() * tile.height() * 3) as f64;
            let ratio_over_two = pixels_over_two as f64 / (tile.width() * tile.height()) as f64;
            eprintln!(
                "TILE_PARITY x={} y={} mae={:.4} max_delta={} ratio_over_2={:.6}",
                clip_x, clip_y, mae, max_channel_delta, ratio_over_two
            );
            assert!(
                mae <= 5.0,
                "MAE tile quá lớn tại ({clip_x}, {clip_y}): {mae}"
            );
            assert!(
                ratio_over_two <= 0.35,
                "quá nhiều pixel lệch tại ({clip_x}, {clip_y}): {ratio_over_two}"
            );
        }
    }
}

// STARTUP (fix 2026-08-04): cửa sổ chính chỉ được hiện sau khi Rust setup và
// sidecar đã sẵn sàng. Nếu user mở shortcut lần hai trong lúc cold-start, callback
// single-instance vẫn nhận args nhưng không làm lộ khung WebView trong suốt.
static APP_STARTUP_READY: AtomicBool = AtomicBool::new(false);
static FRONTEND_INTERACTIVE_RECORDED: AtomicBool = AtomicBool::new(false);

// SEC (audit 2026-09-02 §SEC.18): PID trần không đủ định danh tiến trình vì Windows
// có thể tái sử dụng PID. Mỗi thế hệ sidecar được bind với FILETIME tạo process và
// một handle giữ sống process object; event cũ chỉ được clear đúng identity của nó.
#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SidecarProcessIdentity {
    generation: u64,
    pid: u32,
    creation_filetime: u64,
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_generation_matches(
    current: Option<SidecarProcessIdentity>,
    expected: SidecarProcessIdentity,
) -> bool {
    current == Some(expected)
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_creation_matches(identity: SidecarProcessIdentity, observed: Option<u64>) -> bool {
    observed == Some(identity.creation_filetime)
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
struct OwnedSidecarProcessHandle(usize);

#[cfg(all(not(debug_assertions), target_os = "windows"))]
impl OwnedSidecarProcessHandle {
    fn raw(&self) -> windows::Win32::Foundation::HANDLE {
        windows::Win32::Foundation::HANDLE(self.0 as *mut core::ffi::c_void)
    }
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
impl Drop for OwnedSidecarProcessHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.raw()) };
            self.0 = 0;
        }
    }
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
struct RegisteredSidecarProcess {
    identity: SidecarProcessIdentity,
    // Handle này là ownership pin: chừng nào generation còn được đăng ký, PID của
    // process object ấy không thể được Windows cấp lại cho tiến trình khác.
    process: OwnedSidecarProcessHandle,
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
static SIDECAR_PROCESS: OnceLock<Mutex<Option<RegisteredSidecarProcess>>> = OnceLock::new();

#[cfg(all(not(debug_assertions), target_os = "windows"))]
static SIDECAR_GENERATION: AtomicU64 = AtomicU64::new(1);

#[cfg(all(not(debug_assertions), target_os = "windows"))]
static SIDECAR_SHUTDOWN: AtomicBool = AtomicBool::new(false);

// SEC (audit 2026-09-04 §SEC.18/§SEC.22): phân biệt cleanup do RunEvent::Exit
// với hook `cleanup_before_exit()` của updater. Updater 2.10.1 không phát
// RunEvent::Exit trước khi mở installer.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
static RUN_EVENT_EXIT_SEEN: AtomicBool = AtomicBool::new(false);

#[cfg(all(not(debug_assertions), target_os = "windows"))]
static SIDECAR_MASTER_TOKEN: OnceLock<String> = OnceLock::new();

#[cfg(all(not(debug_assertions), target_os = "windows"))]
static SIDECAR_LIFECYCLE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn sidecar_lifecycle_guard() -> std::sync::MutexGuard<'static, ()> {
    SIDECAR_LIFECYCLE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn sidecar_process_guard() -> std::sync::MutexGuard<'static, Option<RegisteredSidecarProcess>> {
    SIDECAR_PROCESS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn filetime_ticks(value: windows::Win32::Foundation::FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn query_process_creation_filetime(process: &OwnedSidecarProcessHandle) -> Result<u64, String> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;

    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(
            process.raw(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    }
    .map_err(|error| format!("GetProcessTimes thất bại: {error}"))?;
    let ticks = filetime_ticks(creation);
    if ticks == 0 {
        Err("GetProcessTimes trả creation FILETIME bằng 0".to_string())
    } else {
        Ok(ticks)
    }
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn pinned_process_is_running(process: &OwnedSidecarProcessHandle) -> Result<bool, String> {
    use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::WaitForSingleObject;

    match unsafe { WaitForSingleObject(process.raw(), 0) } {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 => Ok(false),
        other => Err(format!(
            "WaitForSingleObject trả mã không hợp lệ: {}",
            other.0
        )),
    }
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn capture_sidecar_process(pid: u32) -> Result<RegisteredSidecarProcess, String> {
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    if pid == 0 {
        return Err("PID sidecar bằng 0".to_string());
    }
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .map_err(|error| format!("Không mở được process sidecar PID={pid}: {error}"))?;
    // Chuyển ownership của HANDLE sang RAII ngay lập tức; mọi nhánh lỗi phía dưới
    // đều drop và CloseHandle đúng một lần.
    let process = OwnedSidecarProcessHandle(handle.0 as usize);
    let creation_filetime = query_process_creation_filetime(&process)?;
    if !pinned_process_is_running(&process)? {
        return Err(format!("Sidecar PID={pid} đã thoát ngay sau spawn"));
    }
    let generation = SIDECAR_GENERATION.fetch_add(1, Ordering::Relaxed);
    if generation == 0 {
        return Err("Bộ đếm thế hệ sidecar đã tràn".to_string());
    }
    Ok(RegisteredSidecarProcess {
        identity: SidecarProcessIdentity {
            generation,
            pid,
            creation_filetime,
        },
        process,
    })
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn publish_sidecar_process(
    registered: RegisteredSidecarProcess,
) -> Result<SidecarProcessIdentity, String> {
    let identity = registered.identity;
    let mut current = sidecar_process_guard();
    if let Some(existing) = current.as_ref() {
        return Err(format!(
            "Không thể đăng ký generation={} PID={}: generation={} PID={} vẫn còn",
            identity.generation, identity.pid, existing.identity.generation, existing.identity.pid
        ));
    }
    *current = Some(registered);
    Ok(identity)
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn register_spawned_sidecar(pid: u32) -> Result<SidecarProcessIdentity, String> {
    // SEC (audit 2026-09-04 §SEC.22): gán Job là thao tác đầu tiên sau child.pid()
    // để thu hẹp cửa sổ tiến trình con kịp sinh cháu ngoài Job. Lỗi phải fail-closed;
    // caller sẽ kill CommandChild vừa spawn và không publish generation.
    process_guard::adopt_child_process(pid)
        .map_err(|error| format!("Không bảo vệ được sidecar bằng Job Object: {error}"))?;
    // Capture HANDLE + FILETIME pin process object trong cả vòng đời generation.
    let captured = capture_sidecar_process(pid)?;
    publish_sidecar_process(captured)
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn sidecar_bootstrap_protocol_v2(
    master_token: &str,
    identity: SidecarProcessIdentity,
) -> Result<(String, String), String> {
    let session_token = security::derive_sidecar_session_token(master_token, identity.generation)?;
    let record = format!(
        "PRYNX-SIDECAR-V2:{}:{}\n",
        master_token, identity.generation
    );
    Ok((record, session_token))
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn publish_verified_sidecar_session(
    identity: SidecarProcessIdentity,
    session_token: &str,
    sidecar_exited: &AtomicBool,
) -> Result<(), String> {
    // Giữ lifecycle + process lock xuyên suốt compare-and-publish. Event muộn của
    // generation cũ hoặc shutdown không thể chen vào rồi để lại signer mồ côi.
    let _lifecycle_guard = sidecar_lifecycle_guard();
    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
        return Err("Ứng dụng đang shutdown".to_string());
    }
    if sidecar_exited.load(Ordering::Acquire) {
        return Err("Sidecar đã thoát trước khi publish khóa phiên".to_string());
    }
    let current = sidecar_process_guard();
    if !sidecar_generation_matches(
        current.as_ref().map(|registered| registered.identity),
        identity,
    ) {
        return Err("Identity sidecar đã đổi trước khi publish khóa phiên".to_string());
    }
    security::publish_sidecar_session_token(identity.generation, session_token)
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn current_sidecar_identity() -> Option<SidecarProcessIdentity> {
    sidecar_process_guard()
        .as_ref()
        .map(|registered| registered.identity)
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn take_sidecar_generation(expected: SidecarProcessIdentity) -> Option<RegisteredSidecarProcess> {
    let mut current = sidecar_process_guard();
    if !sidecar_generation_matches(
        current.as_ref().map(|registered| registered.identity),
        expected,
    ) {
        return None;
    }
    // Giữ process lock tới sau compare-and-clear session. Generation mới không thể
    // được register xen giữa lúc gỡ identity cũ và lúc vô hiệu signer cũ.
    security::clear_sidecar_session_token(expected.generation);
    current.take()
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn clear_sidecar_generation(expected: SidecarProcessIdentity) -> bool {
    // Compare-and-clear toàn bộ identity; event generation cũ không thể đóng handle
    // hoặc xóa state của generation mới dù Windows cấp lại cùng numeric PID.
    if take_sidecar_generation(expected).is_none() {
        return false;
    }
    true
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn validate_registered_sidecar(registered: &RegisteredSidecarProcess) -> Result<(), String> {
    let observed = query_process_creation_filetime(&registered.process)?;
    if !sidecar_creation_matches(registered.identity, Some(observed)) {
        return Err(format!(
            "creation FILETIME không khớp generation={} PID={}",
            registered.identity.generation, registered.identity.pid
        ));
    }
    if !pinned_process_is_running(&registered.process)? {
        return Err(format!(
            "generation={} PID={} đã thoát",
            registered.identity.generation, registered.identity.pid
        ));
    }
    Ok(())
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
const NUITKA_ONEFILE_STATE_ENV_KEYS: [&str; 5] = [
    "NUITKA_ONEFILE_PARENT",
    "NUITKA_ONEFILE_START",
    "NUITKA_ONEFILE_TIME_US",
    "NUITKA_ONEFILE_RANDOM",
    "NUITKA_ONEFILE_DIRECTORY",
];

// SEC (audit 2026-09-03 §SEC.19): các biến dưới đây có thể đổi trust anchor,
// bật dev/fail-open hoặc làm lộ secret nếu được kế thừa từ môi trường của tiến
// trình cha. Sidecar release được dựng bằng `env_clear()` rồi chỉ nhận giá trị
// an toàn do host đặt tường minh bên dưới; không truyền nguyên các override này.
#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
const SIDECAR_SECURITY_ENV_KEYS: [&str; 21] = [
    "DEV_MODE",
    "PRYNX_CLK_KEY_FILE",
    "PRYNX_CLOCK_GUARD_FILE",
    "PRYNX_ENFORCE_CLOCK_ANCHOR",
    "PRYNX_ENFORCE_LICENSE_TOKEN",
    "PRYNX_LICENSE_PUBLIC_KEY",
    "PRYNX_MAX_TOKEN_LIFETIME_SECONDS",
    "PRYNX_SIDECAR_TOKEN",
    "PRYNX_TOKEN_FILE",
    "PRYNX_TOKEN_SOURCE",
    "PRYNX_DPAPI_IN",
    // SEC (audit 2026-09-05 §LOG.01/§LOG.03): binary release không kế thừa
    // cờ diagnostic từ môi trường máy khách. Host sẽ đặt PRYNX_PERF=0 rõ ràng;
    // các cờ còn lại không cần tồn tại trong sidecar production.
    "PRYNX_PERF",
    "PRYNX_PERF_DIR",
    "PRYNX_ROT_AUDIT",
    "PRYNX_NESTING_TRACE_ENABLED",
    "PRYNX_NESTING_TRACE_PATH",
    "PRYNX_EDIT_BUG_LOG",
    "PRYNX_EDIT_BUG_LOG_PATH",
    "PRYNX_EDIT_TEXT_MOVE_LOG",
    "PRYNX_EDIT_TEXT_MOVE_LOG_PATH",
    "STICKER_DEBUG",
];

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn filter_sidecar_environment<I>(environment: I) -> Vec<(std::ffi::OsString, std::ffi::OsString)>
where
    I: IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
{
    environment
        .into_iter()
        .filter(|(name, _)| {
            let name = name.to_string_lossy();
            !NUITKA_ONEFILE_STATE_ENV_KEYS
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
                && !SIDECAR_SECURITY_ENV_KEYS
                    .iter()
                    .any(|blocked| name.eq_ignore_ascii_case(blocked))
        })
        .collect()
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn filtered_sidecar_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    filter_sidecar_environment(std::env::vars_os())
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_shutdown_proof(secret: &str, timestamp: &str, nonce: &str) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "Không khởi tạo được shutdown proof".to_string())?;
    mac.update(format!("shutdown:{timestamp}:{nonce}").as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_shutdown_request(secret: &str, timestamp: &str, nonce: &str) -> Result<String, String> {
    let proof = sidecar_shutdown_proof(secret, timestamp, nonce)?;
    Ok(format!(
        "POST /__prynx/shutdown HTTP/1.1\r\nHost: 127.0.0.1:8321\r\nConnection: close\r\nContent-Length: 0\r\nX-PrynX-Shutdown-Timestamp: {timestamp}\r\nX-PrynX-Shutdown-Nonce: {nonce}\r\nX-PrynX-Shutdown-Proof: {proof}\r\n\r\n"
    ))
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn request_sidecar_shutdown(secret: &str) -> Result<(), String> {
    use rand::RngCore;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Đồng hồ hệ thống không hợp lệ".to_string())?
        .as_secs()
        .to_string();
    let mut nonce_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = hex::encode(nonce_bytes);
    let request = sidecar_shutdown_request(secret, &timestamp, &nonce)?;
    let address: SocketAddr = "127.0.0.1:8321"
        .parse()
        .map_err(|error| format!("Địa chỉ shutdown không hợp lệ: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("Không kết nối được endpoint shutdown: {error}"))?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Không gửi được lệnh shutdown: {error}"))?;

    let mut response = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    while !response.windows(4).any(|window| window == b"\r\n\r\n") {
        let size = stream
            .read(&mut chunk)
            .map_err(|error| format!("Không đọc được phản hồi shutdown: {error}"))?;
        if size == 0 {
            break;
        }
        if response.len() + size > 8 * 1024 {
            return Err("Phản hồi shutdown vượt giới hạn 8 KiB".to_string());
        }
        response.extend_from_slice(&chunk[..size]);
    }
    let status = std::str::from_utf8(&response)
        .map_err(|_| "Phản hồi shutdown không phải UTF-8".to_string())?;
    if status.starts_with("HTTP/1.1 202 ") || status.starts_with("HTTP/1.0 202 ") {
        Ok(())
    } else {
        Err("Sidecar từ chối lệnh shutdown có xác thực".to_string())
    }
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn force_kill_registered_sidecar(registered: &RegisteredSidecarProcess) -> bool {
    // Handle được OpenProcess ngay sau spawn và giữ mở trong state tới đây, nên process
    // object/PID không thể bị tái sử dụng. Vẫn query FILETIME ngay trước taskkill như
    // defense-in-depth; mọi lỗi/mismatch đều fail-safe về Job Object, không kill PID trần.
    if let Err(error) = validate_registered_sidecar(registered) {
        log::warn!(
            "[SIDECAR] Bỏ qua taskkill generation={} PID={}: {error}; dựa vào Job Object",
            registered.identity.generation,
            registered.identity.pid
        );
        startup_breadcrumb("sidecar force-kill: identity unavailable; relying on job object");
        return false;
    }

    let pid = registered.identity.pid;
    let taskkill = match process_guard::system_taskkill_path() {
        Ok(path) => path,
        Err(error) => {
            log::warn!(
                "[SIDECAR] Không tìm được taskkill hệ thống cho generation={} PID={}: {error}; dựa vào Job Object",
                registered.identity.generation,
                pid
            );
            startup_breadcrumb(
                "sidecar force-kill: trusted taskkill unavailable; relying on job object",
            );
            return false;
        }
    };
    match std::process::Command::new(taskkill)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .output()
    {
        Ok(output) if output.status.success() => {
            log::warn!(
                "[SIDECAR] Đã dừng cây generation={} PID={} bằng taskkill /T /F",
                registered.identity.generation,
                pid
            );
            true
        }
        Ok(output) => {
            log::warn!(
                "[SIDECAR] taskkill generation={} PID={} trả mã {:?}; Job Object vẫn là lưới cuối",
                registered.identity.generation,
                pid,
                output.status.code()
            );
            false
        }
        Err(error) => {
            log::warn!(
                "[SIDECAR] Không chạy được taskkill generation={} PID={}: {error}; dựa vào Job Object",
                registered.identity.generation,
                pid
            );
            false
        }
    }
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn kill_sidecar(expected: SidecarProcessIdentity) {
    if let Some(registered) = take_sidecar_generation(expected) {
        let _ = force_kill_registered_sidecar(&registered);
    }
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn shutdown_sidecar_gracefully_locked() -> Result<(), String> {
    use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::WaitForSingleObject;

    // Đồng bộ với supervisor để không có thế hệ mới được spawn giữa lúc ta claim PID
    // và gửi lệnh shutdown. Guard chỉ giữ trong lifecycle transition; supervisor không
    // giữ nó trong lúc chờ health nên không chặn cold-start dài.
    let Some(identity) = current_sidecar_identity() else {
        return Ok(());
    };
    let shutdown_secret = security::sidecar_session_token_for_generation(identity.generation);
    let Some(registered) = take_sidecar_generation(identity) else {
        return Err("Identity sidecar đổi trong lúc chuẩn bị shutdown".to_string());
    };
    // `take_sidecar_generation` đã vô hiệu signer atomically. Local copy chỉ sống
    // đủ lâu để gửi đúng một shutdown request cho generation vừa claim.
    if let Err(error) = validate_registered_sidecar(&registered) {
        log::warn!(
            "[SIDECAR] Không xác minh được generation={} PID={} trước shutdown: {error}; dựa vào Job Object",
            identity.generation,
            identity.pid
        );
        startup_breadcrumb("sidecar shutdown: identity unavailable; relying on job object");
        return Err(format!(
            "Không xác minh được sidecar trước shutdown: {error}"
        ));
    }

    let request_result = shutdown_secret.and_then(|secret| request_sidecar_shutdown(&secret));
    let wait_result = if request_result.is_ok() {
        // Uvicorn có graceful deadline 12 giây; phần còn lại dành cho bootstrap Nuitka
        // dọn payload temporary trước khi app/installer đóng Job Object.
        Some(unsafe { WaitForSingleObject(registered.process.raw(), 20_000) })
    } else {
        None
    };

    if wait_result == Some(WAIT_OBJECT_0) {
        log::info!(
            "[SIDECAR] generation={} PID={} đã shutdown êm và bootstrap Nuitka đã thoát",
            identity.generation,
            identity.pid
        );
        startup_breadcrumb("sidecar shutdown: graceful");
        return Ok(());
    }

    match (&request_result, wait_result) {
        (Err(error), _) => log::warn!("[SIDECAR] Shutdown êm thất bại: {error}"),
        (Ok(()), Some(WAIT_TIMEOUT)) => {
            log::warn!("[SIDECAR] Shutdown êm PID={} quá hạn 20 giây", identity.pid)
        }
        (Ok(()), Some(other)) => {
            log::warn!(
                "[SIDECAR] WaitForSingleObject PID={} trả mã {}",
                identity.pid,
                other.0
            )
        }
        _ => {}
    }
    let forced = force_kill_registered_sidecar(&registered);
    if forced {
        startup_breadcrumb("sidecar shutdown: forced fallback");
    }
    Err(if forced {
        "Sidecar không shutdown êm; đã dùng dừng cưỡng bức nên từ chối mở installer".to_string()
    } else {
        "Sidecar không shutdown êm và dừng cưỡng bức cũng thất bại".to_string()
    })
}

/// SEC (audit 2026-09-04 §SEC.18/§SEC.22): một đường cleanup idempotent dùng
/// chung cho command UI và hook native ngay trước khi updater mở installer.
fn cleanup_children_before_installer() -> Result<(), String> {
    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    let sidecar_result = {
        let _lifecycle_guard = sidecar_lifecycle_guard();
        SIDECAR_SHUTDOWN.store(true, Ordering::Release);
        shutdown_sidecar_gracefully_locked()
    };

    // Luôn dọn display worker kể cả khi sidecar không shutdown êm; caller vẫn
    // nhận lỗi ở dưới và không được phép tiếp tục mở installer.
    pdf_engine::render_worker::shutdown_render_worker();

    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    sidecar_result?;

    log::warn!("[UPDATE] Đã dọn sidecar và display worker trước khi cài bản mới");
    startup_breadcrumb("update: cleaned child processes before installer");
    Ok(())
}

/// Updater 2.10.1 gọi `AppHandle::cleanup_before_exit()` ngay trước ShellExecute
/// nhưng plugin-level Builder không cho gắn callback riêng. Resource này nằm ở
/// app resource table nên bị drop đúng trong hook đó. Nếu caller React bị bỏ sót
/// hoặc hồi quy, chốt native vẫn cleanup; lỗi làm tiến trình thoát trước installer.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
struct UpdateExitCleanupResource;

#[cfg(all(not(debug_assertions), target_os = "windows"))]
impl tauri::Resource for UpdateExitCleanupResource {}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
impl Drop for UpdateExitCleanupResource {
    fn drop(&mut self) {
        if RUN_EVENT_EXIT_SEEN.load(Ordering::Acquire) {
            return;
        }
        if let Err(error) = cleanup_children_before_installer() {
            log::error!("[UPDATE] Cleanup native trước installer thất bại: {error}");
            startup_breadcrumb("update: native cleanup failed; installer blocked");
            // Callback updater không có kiểu Result. Thoát tại đây là cách fail-closed
            // duy nhất để không quay lại plugin và chạy ShellExecute với file còn khóa.
            std::process::exit(1);
        }
    }
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
const SIDECAR_STARTUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
const SIDECAR_STARTUP_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

#[cfg(any(test, not(debug_assertions)))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct SidecarStoragePaths {
    working_dir: std::path::PathBuf,
    upload_dir: std::path::PathBuf,
    results_dir: std::path::PathBuf,
}

#[cfg(any(test, not(debug_assertions)))]
fn prepare_sidecar_storage(
    app_local_data_dir: &std::path::Path,
) -> Result<SidecarStoragePaths, String> {
    // STARTUP (fix 2026-08-07): backend dùng ./data, ./uploads và ./results. Neo cwd vào
    // vùng dữ liệu riêng của ứng dụng để Windows không tạo ba thư mục này cạnh file user.
    let working_dir = app_local_data_dir.join("backend");
    let data_dir = working_dir.join("data");
    let upload_dir = working_dir.join("uploads");
    let results_dir = working_dir.join("results");

    for dir in [&working_dir, &data_dir, &upload_dir, &results_dir] {
        std::fs::create_dir_all(dir).map_err(|error| {
            format!(
                "Không tạo được thư mục nội bộ của PrynX tại {}: {error}",
                dir.display()
            )
        })?;
    }

    Ok(SidecarStoragePaths {
        working_dir,
        upload_dir,
        results_dir,
    })
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn spawn_sidecar_process<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    storage: &SidecarStoragePaths,
) -> Result<
    (
        tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
        tauri_plugin_shell::process::CommandChild,
    ),
    String,
> {
    use tauri_plugin_shell::ShellExt;

    let sidecar = app
        .shell()
        .sidecar("pdf-inspector-backend")
        .map_err(|error| format!("Không tìm thấy binary sidecar: {error}"))?;
    sidecar
        .env_clear()
        .envs(filtered_sidecar_environment())
        .current_dir(&storage.working_dir)
        .env("UPLOAD_DIR", &storage.upload_dir)
        .env("RESULTS_DIR", &storage.results_dir)
        .args(["--port", "8321"])
        .envs([
            ("DEV_MODE", "false"),
            // SEC (audit 2026-09-03 §SEC.19-R1): mỗi thế hệ nhận bootstrap v2 và
            // derive khóa phiên riêng; signer chỉ publish sau startup proof.
            ("PRYNX_TOKEN_SOURCE", "stdin"),
            ("PRYNX_PERF", if preview_perf_enabled() { "1" } else { "0" }),
            ("PRYNX_ENFORCE_LICENSE_TOKEN", "true"),
            (
                "PRYNX_FEATURE_GATING_ENABLED",
                option_env!("PRYNX_FEATURE_GATING_ENABLED").unwrap_or(if cfg!(debug_assertions) {
                    "false"
                } else {
                    "true"
                }),
            ),
            (
                "PRYNX_LOGO_REBUILD_ENABLED",
                option_env!("PRYNX_LOGO_REBUILD_ENABLED").unwrap_or("false"),
            ),
            ("PRYNX_MAX_TOKEN_LIFETIME_SECONDS", "691200"),
        ])
        .spawn()
        .map_err(|error| format!("Không spawn được sidecar: {error}"))
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
const SIDECAR_HEALTH_RESPONSE_LIMIT: usize = 64 * 1024;

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn startup_retry_delay(remaining: std::time::Duration) -> Option<std::time::Duration> {
    if remaining.is_zero() {
        None
    } else {
        Some(remaining.min(SIDECAR_STARTUP_POLL_INTERVAL))
    }
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn verify_startup_proof(secret: &str, challenge: &str, proof: &str) -> Result<(), String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let proof_bytes =
        hex::decode(proof).map_err(|_| "health startup proof is malformed".to_string())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "cannot initialize startup proof".to_string())?;
    mac.update(format!("startup:{challenge}").as_bytes());
    mac.verify_slice(&proof_bytes)
        .map_err(|_| "health startup proof does not match this PrynX instance".to_string())
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_startup_timeout_error(timeout: std::time::Duration) -> String {
    let label = if timeout.subsec_millis() == 0 {
        format!("{} giây", timeout.as_secs())
    } else {
        format!("{} ms", timeout.as_millis())
    };
    format!("sidecar không sẵn sàng trong vòng {label}")
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn verify_sidecar_startup_at(
    address: std::net::SocketAddr,
    secret: &str,
    timeout: std::time::Duration,
    sidecar_exited: &AtomicBool,
) -> Result<(), String> {
    use rand::RngCore;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    let mut challenge_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut challenge_bytes);
    let challenge = hex::encode(challenge_bytes);
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| "Thời hạn chờ sidecar không hợp lệ".to_string())?;

    loop {
        if sidecar_exited.load(Ordering::Acquire) {
            return Err("sidecar đã thoát trước khi sẵn sàng".to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let Some(connect_timeout) = startup_retry_delay(remaining) else {
            break;
        };
        let mut stream = match TcpStream::connect_timeout(&address, connect_timeout) {
            Ok(stream) => stream,
            Err(_) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if let Some(delay) = startup_retry_delay(remaining) {
                    std::thread::sleep(delay);
                }
                continue;
            }
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        stream
            .set_write_timeout(Some(remaining.min(Duration::from_millis(500))))
            .ok();
        let request = format!(
            "GET /health?challenge={} HTTP/1.1\r\nHost: 127.0.0.1:8321\r\nConnection: close\r\n\r\n",
            challenge
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|e| format!("health write: {e}"))?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut response_bytes = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        loop {
            if sidecar_exited.load(Ordering::Acquire) {
                return Err("sidecar đã thoát trước khi sẵn sàng".to_string());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(sidecar_startup_timeout_error(timeout));
            }
            stream
                .set_read_timeout(Some(remaining.min(Duration::from_millis(750))))
                .ok();
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => {
                    if response_bytes.len() + size > SIDECAR_HEALTH_RESPONSE_LIMIT {
                        return Err("health response vượt giới hạn 64 KiB".to_string());
                    }
                    response_bytes.extend_from_slice(&chunk[..size]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(format!("health read: {error}")),
            }
        }
        let response = String::from_utf8(response_bytes)
            .map_err(|_| "health response is not valid UTF-8".to_string())?;
        if !response.starts_with("HTTP/1.1 200") {
            return Err("unknown listener returned a non-200 health response".to_string());
        }
        let body = response
            .split("\r\n\r\n")
            .nth(1)
            .ok_or_else(|| "health response has no body".to_string())?;
        let value: serde_json::Value = serde_json::from_str(body)
            .map_err(|_| "health response is not valid JSON".to_string())?;
        let proof = value
            .get("proof")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "health response has no startup proof".to_string())?;
        verify_startup_proof(secret, &challenge, proof)?;
        return Ok(());
    }
    Err(sidecar_startup_timeout_error(timeout))
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn verify_sidecar_startup(secret: &str, sidecar_exited: &AtomicBool) -> Result<(), String> {
    let address = "127.0.0.1:8321"
        .parse()
        .map_err(|e| format!("address: {e}"))?;
    verify_sidecar_startup_at(address, secret, SIDECAR_STARTUP_TIMEOUT, sidecar_exited)
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn sidecar_port_is_free() -> bool {
    std::net::TcpListener::bind(("127.0.0.1", 8321u16)).is_ok()
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn sidecar_identity_is_ready(secret: &str) -> bool {
    let address = match "127.0.0.1:8321".parse() {
        Ok(address) => address,
        Err(_) => return false,
    };
    let probe_exited = AtomicBool::new(false);
    verify_sidecar_startup_at(
        address,
        secret,
        std::time::Duration::from_secs(2),
        &probe_exited,
    )
    .is_ok()
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SidecarRecoveryAction {
    KeepVerifiedListener,
    Restart,
    WaitForUnknownListener,
    Stop,
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_recovery_action(
    port_is_free: bool,
    identity_is_ready: bool,
    failed_attempts: u32,
) -> SidecarRecoveryAction {
    if !port_is_free {
        if identity_is_ready {
            SidecarRecoveryAction::KeepVerifiedListener
        } else if failed_attempts >= 2 {
            SidecarRecoveryAction::Stop
        } else {
            SidecarRecoveryAction::WaitForUnknownListener
        }
    } else if failed_attempts >= 3 {
        SidecarRecoveryAction::Stop
    } else {
        SidecarRecoveryAction::Restart
    }
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_restart_delay(attempt: u32) -> std::time::Duration {
    match attempt {
        1 => std::time::Duration::from_millis(250),
        2 => std::time::Duration::from_secs(1),
        _ => std::time::Duration::from_secs(3),
    }
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn replace_sidecar_generation_exit_flag(current: &mut Arc<AtomicBool>) -> Arc<AtomicBool> {
    // SEC (audit 2026-08-15 §SIG.02): mỗi thế hệ giữ cờ riêng. Event stream
    // của tiến trình cũ đóng muộn không được đánh dấu nhầm tiến trình mới đã chết.
    let next = Arc::new(AtomicBool::new(false));
    *current = Arc::clone(&next);
    next
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn start_sidecar_event_reader(
    mut rx: tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
    sidecar_exited: Arc<AtomicBool>,
    identity: SidecarProcessIdentity,
) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Some(notice) = sidecar_stream_notice("stdout", &bytes) {
                        log::debug!("{notice}");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Some(notice) = sidecar_stream_notice("stderr", &bytes) {
                        // SEC (audit 2026-09-05 §LOG.04): Python logging/traceback có
                        // thể mang path, payload và tên engine. Release chỉ ghi việc
                        // sidecar có phát diagnostic ở DEBUG, không chép nội dung và
                        // không để stderr INFO của Python làm ngập file log release.
                        log::debug!("{notice}");
                    }
                }
                CommandEvent::Terminated(payload) => {
                    sidecar_exited.store(true, Ordering::Release);
                    let _ = clear_sidecar_generation(identity);
                    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                        log::info!(
                            "[SIDECAR] Terminated theo shutdown code={:?} signal={:?}",
                            payload.code,
                            payload.signal
                        );
                    } else {
                        log::error!(
                            "[SIDECAR] Terminated code={:?} signal={:?}",
                            payload.code,
                            payload.signal
                        );
                    }
                }
                CommandEvent::Error(_error) => {
                    sidecar_exited.store(true, Ordering::Release);
                    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                        log::info!("[SIDECAR] Event stream đóng khi shutdown");
                    } else {
                        log::error!("[SIDECAR] Event stream gặp lỗi; chi tiết đã được ẩn");
                    }
                }
                _ => {}
            }
        }

        sidecar_exited.store(true, Ordering::Release);
        if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
            log::info!(
                "[SIDECAR] Event stream đã đóng theo shutdown cho generation={} PID={}",
                identity.generation,
                identity.pid
            );
        } else {
            log::error!(
                "[SIDECAR] Event stream closed for generation={} PID={}",
                identity.generation,
                identity.pid
            );
        }
    });
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
fn sidecar_stream_notice(kind: &str, bytes: &[u8]) -> Option<String> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    let safe_kind = if kind == "stderr" { "stderr" } else { "stdout" };
    Some(format!(
        "[SIDECAR] nội dung {safe_kind} đã được ẩn trong bản release ({} byte)",
        bytes.len()
    ))
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn start_sidecar_supervisor<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    storage: SidecarStoragePaths,
    sidecar_master_token: String,
    sidecar_exited: Arc<AtomicBool>,
) {
    if let Err(error) = std::thread::Builder::new()
        .name("prynx-sidecar-supervisor".to_string())
        .spawn(move || {
            let mut failed_restarts = 0u32;
            let mut monitoring_without_events = false;
            let mut current_sidecar_exited = sidecar_exited;

            loop {
                if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                    return;
                }
                if !current_sidecar_exited.load(Ordering::Acquire) {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                }

                // Pipe reader có thể lỗi trong khi listener vẫn đúng instance.
                // Probe proof trước để tránh spawn trùng hoặc đụng listener lạ.
                let port_is_free = sidecar_port_is_free();
                let identity_is_ready = if port_is_free {
                    false
                } else if let Some(identity) = current_sidecar_identity() {
                    security::sidecar_session_token_for_generation(identity.generation)
                        .map(|token| sidecar_identity_is_ready(&token))
                        .unwrap_or(false)
                } else {
                    false
                };
                match sidecar_recovery_action(
                    port_is_free,
                    identity_is_ready,
                    failed_restarts,
                ) {
                    SidecarRecoveryAction::KeepVerifiedListener => {
                        failed_restarts = 0;
                        if !monitoring_without_events {
                            monitoring_without_events = true;
                            log::warn!(
                                "[SIDECAR] Event stream lỗi nhưng startup proof vẫn hợp lệ; chuyển sang probe định kỳ"
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        continue;
                    }
                    SidecarRecoveryAction::WaitForUnknownListener => {
                        failed_restarts = failed_restarts.saturating_add(1);
                        log::error!(
                            "[SIDECAR] Port 8321 bị chiếm bởi listener không xác thực; chưa tự ý kill tiến trình lạ (lần {failed_restarts}/3)"
                        );
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        continue;
                    }
                    SidecarRecoveryAction::Stop => {
                        log::error!(
                            "[SIDECAR] Dừng recovery sau 3 lần thất bại hoặc gặp listener không xác thực; cần mở lại ứng dụng"
                        );
                        // SEC (audit 2026-09-03 §SEC.19-R1): dừng supervisor phải
                        // đồng nghĩa thu hồi signer. Nếu event pipe đã mất nhưng một
                        // listener lạ vẫn chiếm cổng, giữ generation cũ trong RAM sẽ
                        // để Rust tiếp tục ký bằng một authority không còn được giám sát.
                        let _lifecycle_guard = sidecar_lifecycle_guard();
                        if let Some(identity) = current_sidecar_identity() {
                            kill_sidecar(identity);
                        }
                        return;
                    }
                    SidecarRecoveryAction::Restart => {}
                }

                {
                    let _lifecycle_guard = sidecar_lifecycle_guard();
                    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                        return;
                    }
                    if let Some(identity) = current_sidecar_identity() {
                        // Event reader lỗi nhưng listener đã biến mất: dọn đúng PID đã spawn
                        // trước khi thay thế, tránh để bootstrap Nuitka treo không giữ port.
                        kill_sidecar(identity);
                    }
                }
                failed_restarts = failed_restarts.saturating_add(1);
                std::thread::sleep(sidecar_restart_delay(failed_restarts));
                let (identity, generation_exited, session_token) = {
                    // Cùng khóa với shutdown: nếu exit thấy PID=0 và trả về thì supervisor
                    // không được spawn một bootstrap mới ngay sau đó.
                    let _lifecycle_guard = sidecar_lifecycle_guard();
                    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                        return;
                    }
                    let (rx, mut child) = match spawn_sidecar_process(&app, &storage) {
                        Ok(value) => value,
                        Err(error) => {
                            log::error!("[SIDECAR] Restart thất bại: {error}");
                            continue;
                        }
                    };
                    let pid = child.pid();
                    let identity = match register_spawned_sidecar(pid) {
                        Ok(identity) => identity,
                        Err(error) => {
                            log::error!(
                                "[SIDECAR] Không bind được identity khi restart PID={pid}: {error}"
                            );
                            let _ = child.kill();
                            continue;
                        }
                    };
                    let (bootstrap_record, session_token) =
                        match sidecar_bootstrap_protocol_v2(&sidecar_master_token, identity) {
                            Ok(value) => value,
                            Err(error) => {
                                log::error!(
                                    "[SIDECAR] Không derive được khóa phiên khi restart: {error}"
                                );
                                kill_sidecar(identity);
                                continue;
                            }
                        };
                    let generation_exited =
                        replace_sidecar_generation_exit_flag(&mut current_sidecar_exited);
                    start_sidecar_event_reader(
                        rx,
                        Arc::clone(&generation_exited),
                        identity,
                    );

                    if let Err(error) = child.write(bootstrap_record.as_bytes()) {
                        log::error!("[SIDECAR] Ghi token khi restart thất bại: {error}");
                        generation_exited.store(true, Ordering::Release);
                        kill_sidecar(identity);
                        continue;
                    }
                    (identity, generation_exited, session_token)
                };
                if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                    return;
                }
                startup_breadcrumb("sidecar recovery: waiting for startup proof");
                if let Err(error) = verify_sidecar_startup(&session_token, &generation_exited) {
                    log::error!("[SIDECAR] Startup proof sau restart thất bại: {error}");
                    startup_breadcrumb(&format!("sidecar recovery: FAIL {error}"));
                    generation_exited.store(true, Ordering::Release);
                    kill_sidecar(identity);
                    continue;
                }
                if let Err(error) = publish_verified_sidecar_session(
                    identity,
                    &session_token,
                    &generation_exited,
                ) {
                    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                        return;
                    }
                    log::error!("[SIDECAR] Không publish được khóa phiên mới: {error}");
                    generation_exited.store(true, Ordering::Release);
                    kill_sidecar(identity);
                    continue;
                }

                failed_restarts = 0;
                monitoring_without_events = false;
                log::warn!("[SIDECAR] Đã khởi động lại và xác thực thành công trên port 8321");
                startup_breadcrumb("sidecar recovery: ready (startup proof OK)");
                start_sidecar_cache_cleanup(identity.pid);
            }
        })
    {
        log::error!("[SIDECAR] Không tạo được supervisor runtime: {error}");
    }
}

#[cfg(test)]
mod sidecar_startup_tests {
    use super::{
        filter_sidecar_environment, nuitka_temp_extraction_pid, prepare_sidecar_storage,
        prune_stale_nuitka_extractions, replace_sidecar_generation_exit_flag,
        sidecar_creation_matches, sidecar_generation_matches, sidecar_recovery_action,
        sidecar_restart_delay, sidecar_shutdown_proof, sidecar_shutdown_request,
        sidecar_startup_timeout_error, sidecar_stream_notice, startup_retry_delay,
        verify_startup_proof, SidecarProcessIdentity, SidecarRecoveryAction,
        SIDECAR_SECURITY_ENV_KEYS, SIDECAR_STARTUP_TIMEOUT,
    };
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn storage_sidecar_nam_trong_app_local_data() {
        let test_root = std::env::temp_dir().join(format!(
            "prynx_sidecar_storage_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app_local_data = test_root.join("app-local-data");

        let storage = prepare_sidecar_storage(&app_local_data).unwrap();

        assert_eq!(storage.working_dir, app_local_data.join("backend"));
        assert_eq!(storage.upload_dir, storage.working_dir.join("uploads"));
        assert_eq!(storage.results_dir, storage.working_dir.join("results"));
        assert!(storage.working_dir.join("data").is_dir());
        assert!(storage.upload_dir.is_dir());
        assert!(storage.results_dir.is_dir());
        assert!(!test_root.join("data").exists());
        assert!(!test_root.join("uploads").exists());
        assert!(!test_root.join("results").exists());

        std::fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn retry_dung_tai_deadline_va_timeout_release_la_60_giay() {
        assert_eq!(SIDECAR_STARTUP_TIMEOUT, Duration::from_secs(60));
        assert_eq!(
            startup_retry_delay(Duration::from_millis(350)),
            Some(Duration::from_millis(100))
        );
        assert_eq!(
            startup_retry_delay(Duration::from_millis(50)),
            Some(Duration::from_millis(50))
        );
        assert_eq!(startup_retry_delay(Duration::ZERO), None);
        assert_eq!(
            sidecar_startup_timeout_error(SIDECAR_STARTUP_TIMEOUT),
            "sidecar không sẵn sàng trong vòng 60 giây"
        );
    }

    #[test]
    fn proof_backend_hop_le_duoc_nhan_va_proof_bi_sua_bi_tu_choi() {
        let challenge = "0000000000000000000000000000000000000000000000000000000000000000";
        let proof = "0b857df7768b9fc957d9a5df81f2b509e8e2c9bfbb9a08a39195fb7ff3cce17e";

        assert_eq!(
            verify_startup_proof("test-secret", challenge, proof),
            Ok(())
        );
        assert!(
            verify_startup_proof("test-secret", challenge, &format!("{}0", &proof[..63])).is_err()
        );
        assert!(verify_startup_proof("test-secret", challenge, "khong-phai-hex").is_err());
    }

    #[test]
    fn shutdown_proof_khop_backend_va_request_khong_co_body() {
        let nonce = "0000000000000000000000000000000000000000000000000000000000000000";
        let proof = sidecar_shutdown_proof("test-secret", "1700000000", nonce).unwrap();
        assert_eq!(
            proof,
            "588aaddf45d655203bc8a4322d2ba0d04fd40863ca2cf8e203d42cb61106c5b2"
        );

        let request = sidecar_shutdown_request("test-secret", "1700000000", nonce).unwrap();
        assert!(request.starts_with("POST /__prynx/shutdown HTTP/1.1\r\n"));
        assert!(request.contains("Content-Length: 0\r\n"));
        assert!(request.contains(&format!("X-PrynX-Shutdown-Proof: {proof}\r\n")));
        assert!(request.ends_with("\r\n\r\n"));
    }

    #[test]
    fn moi_truong_sidecar_loai_state_nuitka_khong_phan_biet_hoa_thuong() {
        let filtered = filter_sidecar_environment(vec![
            (OsString::from("Path"), OsString::from("C:\\Windows")),
            (
                OsString::from("nuitka_onefile_parent"),
                OsString::from("attacker"),
            ),
            (
                OsString::from("Nuitka_Onefile_Start"),
                OsString::from("attacker"),
            ),
            (
                OsString::from("NUITKA_ONEFILE_TIME_US"),
                OsString::from("attacker"),
            ),
            (
                OsString::from("nUiTkA_oNeFiLe_RaNdOm"),
                OsString::from("attacker"),
            ),
            (
                OsString::from("NUITKA_ONEFILE_DIRECTORY"),
                OsString::from("attacker"),
            ),
            (
                OsString::from("NUITKA_ONEFILE_RANDOM_EXTRA"),
                OsString::from("allowed"),
            ),
            (OsString::from("PRYNX_PERF"), OsString::from("1")),
            (OsString::from("prynx_rot_audit"), OsString::from("1")),
            (
                OsString::from("PRYNX_NESTING_TRACE_PATH"),
                OsString::from("C:\\du-lieu-khach.jsonl"),
            ),
            (OsString::from("STICKER_DEBUG"), OsString::from("true")),
            (
                OsString::from("PRYNX_CLK_KEY_FILE"),
                OsString::from("attacker"),
            ),
            (
                OsString::from("prynx_clock_guard_file"),
                OsString::from("attacker"),
            ),
            (
                OsString::from("PRYNX_MAX_TOKEN_LIFETIME_SECONDS"),
                OsString::from("999999999"),
            ),
            (
                OsString::from("PRYNX_ENFORCE_CLOCK_ANCHOR"),
                OsString::from("0"),
            ),
            (
                OsString::from("PRYNX_LICENSE_PUBLIC_KEY"),
                OsString::from("attacker"),
            ),
            (OsString::from("DEV_MODE"), OsString::from("true")),
        ]);
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().any(|(name, _)| name == "Path"));
        assert!(filtered
            .iter()
            .any(|(name, _)| name == "NUITKA_ONEFILE_RANDOM_EXTRA"));
        assert!(filtered.iter().all(|(name, _)| {
            !SIDECAR_SECURITY_ENV_KEYS
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
        }));
    }

    #[test]
    fn log_stream_sidecar_release_khong_chep_noi_dung_nhay_cam() {
        let sentinel = br#"Traceback C:\\KhachHang\\don-hang.pdf ENGINE_SECRET"#;
        let notice = sidecar_stream_notice("stderr", sentinel).unwrap();

        assert!(notice.contains("stderr"));
        assert!(notice.contains(&sentinel.len().to_string()));
        assert!(!notice.contains("KhachHang"));
        assert!(!notice.contains("ENGINE_SECRET"));
        assert!(sidecar_stream_notice("stdout", b" \r\n\t").is_none());
    }

    #[test]
    fn parser_va_prune_extraction_tam_chi_nhan_ten_chuan() {
        assert_eq!(
            nuitka_temp_extraction_pid("sidecar-42-123456-Abcd_123-xy"),
            Some(42)
        );
        for invalid in [
            "sidecar-0-123456-Abcd_123-xy",
            "sidecar-042-123456-Abcd_123-xy",
            "sidecar-42-12345-Abcd_123-xy",
            "sidecar-42-123456-Abcd_123-x",
            "sidecar-42-123456-Abcd.123-xy",
        ] {
            assert_eq!(nuitka_temp_extraction_pid(invalid), None, "{invalid}");
        }

        let test_root = std::env::temp_dir().join(format!(
            "prynx_nuitka_prune_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let base = test_root.join("PrynX");
        let current = base.join("sidecar-42-123456-Abcd_123-xy");
        let active_next = base.join("sidecar-43-222222-Live_456-uv");
        let stale = base.join("sidecar-41-654321-Zyxw_987-qp");
        let invalid = base.join("sidecar-40-65432-Zyxw_987-qp");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::create_dir_all(&active_next).unwrap();
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&invalid).unwrap();
        std::fs::write(stale.join("payload.bin"), b"stale").unwrap();

        // Mô phỏng cleanup thread của PID 42 chạy muộn sau khi supervisor đã dựng PID 43.
        let (removed, failed) = prune_stale_nuitka_extractions(&base, 42, || 43).unwrap();

        assert_eq!(removed, vec!["sidecar-41-654321-Zyxw_987-qp"]);
        assert!(failed.is_empty());
        assert!(current.is_dir());
        assert!(active_next.is_dir());
        assert!(invalid.is_dir());
        assert!(!stale.exists());

        let another_stale = base.join("sidecar-44-333333-Zero_321-ab");
        std::fs::create_dir_all(&another_stale).unwrap();
        let (removed_without_live_pid, _) =
            prune_stale_nuitka_extractions(&base, 999, || 0).unwrap();
        assert!(removed_without_live_pid.is_empty());
        assert!(another_stale.is_dir());
        std::fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn supervisor_chi_restart_khi_port_ranh_va_khong_kill_listener_la() {
        assert_eq!(
            sidecar_recovery_action(true, false, 0),
            SidecarRecoveryAction::Restart
        );
        assert_eq!(
            sidecar_recovery_action(false, true, 2),
            SidecarRecoveryAction::KeepVerifiedListener
        );
        assert_eq!(
            sidecar_recovery_action(false, false, 0),
            SidecarRecoveryAction::WaitForUnknownListener
        );
        assert_eq!(
            sidecar_recovery_action(false, false, 2),
            SidecarRecoveryAction::Stop
        );
    }

    #[test]
    fn supervisor_dung_sau_ba_lan_va_backoff_co_gioi_han() {
        assert_eq!(
            sidecar_recovery_action(true, false, 3),
            SidecarRecoveryAction::Stop
        );
        assert_eq!(sidecar_restart_delay(1), Duration::from_millis(250));
        assert_eq!(sidecar_restart_delay(2), Duration::from_secs(1));
        assert_eq!(sidecar_restart_delay(3), Duration::from_secs(3));
        assert_eq!(sidecar_restart_delay(99), Duration::from_secs(3));

        // Nhánh release-only khó chạy trực tiếp trong unit test debug; khóa lại
        // invariant cấu trúc quan trọng: Stop phải thu hồi generation/signer trước return.
        let source = include_str!("lib.rs");
        let stop_branch = source
            .split_once("SidecarRecoveryAction::Stop => {")
            .and_then(|(_, rest)| rest.split_once("return;").map(|(branch, _)| branch))
            .expect("phải tìm thấy nhánh Stop của supervisor");
        assert!(stop_branch.contains("kill_sidecar(identity)"));
    }

    #[test]
    fn event_the_he_cu_khong_danh_dau_nham_the_he_moi_da_thoat() {
        let mut current = Arc::new(AtomicBool::new(false));
        let previous_reader_flag = Arc::clone(&current);
        let next_reader_flag = replace_sidecar_generation_exit_flag(&mut current);

        previous_reader_flag.store(true, Ordering::Release);

        assert!(previous_reader_flag.load(Ordering::Acquire));
        assert!(!current.load(Ordering::Acquire));
        assert!(Arc::ptr_eq(&current, &next_reader_flag));
    }

    #[test]
    fn identity_sidecar_chan_event_cu_va_pid_tai_su_dung() {
        let current = SidecarProcessIdentity {
            generation: 12,
            pid: 4242,
            creation_filetime: 900_000,
        };
        let old_generation_same_process_fields = SidecarProcessIdentity {
            generation: 11,
            ..current
        };
        let reused_pid = SidecarProcessIdentity {
            generation: 11,
            pid: current.pid,
            creation_filetime: current.creation_filetime - 1,
        };

        assert!(sidecar_generation_matches(Some(current), current));
        assert!(!sidecar_generation_matches(
            Some(current),
            old_generation_same_process_fields
        ));
        assert!(!sidecar_generation_matches(Some(current), reused_pid));
        assert!(sidecar_creation_matches(current, Some(900_000)));
        assert!(!sidecar_creation_matches(current, Some(899_999)));
        assert!(!sidecar_creation_matches(current, None));
    }

    #[test]
    fn hai_duong_spawn_deu_capture_identity_va_raw_taskkill_chi_co_mot_cong() {
        let source = include_str!("lib.rs");
        let register_call = ["register_spawned_", "sidecar("].concat();
        let legacy_pid_state = ["SIDECAR_", "PID"].concat();
        let raw_taskkill = [".args([\"/", "PID\""].concat();

        // Một definition + đúng hai call site: initial spawn và supervisor restart.
        assert_eq!(source.matches(&register_call).count(), 3);
        assert!(!source.contains(&legacy_pid_state));
        // Cổng taskkill duy nhất nằm sau validate FILETIME trên pinned HANDLE.
        assert_eq!(source.matches(&raw_taskkill).count(), 1);
        assert!(source.contains("validate_registered_sidecar(registered)"));
        assert!(source.contains("clear_sidecar_generation(identity)"));
        // SEC (§SEC.22): startup không được quay lại kill theo image name.
        assert!(!source.contains("[\"/IM\", \"pdf-inspector-backend.exe\", \"/F\"]"));
        assert!(source.contains("không được tự ý `taskkill /IM` theo tên"));
    }

    #[test]
    fn cua_so_startup_an_truoc_setup_va_asset_day_du_thong_tin() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        let startup = windows
            .iter()
            .find(|window| window["label"] == "startup")
            .expect("phải có cửa sổ startup riêng");

        // UIUX (startup flash): để Tauri không vẽ cửa sổ trước khi `setup` và
        // event loop sẵn sàng; bản release sẽ xếp lịch show từ worker nền.
        assert_eq!(startup["visible"], false);
        assert_eq!(startup["decorations"], false);
        assert_eq!(startup["resizable"], false);
        assert_eq!(startup["url"], "startup.html");

        let html = include_str!("../../public/startup.html");
        assert!(html.contains("Đang khởi động PrynX"));
        assert!(html.contains("role=\"status\""));
        assert!(!html.contains("<script"));
    }
}

fn tile_cache_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("prynx_tile_cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn tile_disk_path(cache_key: &str) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cache_key.hash(&mut h);
    tile_cache_dir().join(format!("{:016x}.png", h.finish()))
}

const TILE_RENDER_CACHE_VERSION: &str = "v7_userunit_lossless_png";

#[allow(clippy::too_many_arguments)]
fn tile_render_cache_key(
    file_path: &str,
    file_identity: PdfFileIdentity,
    page: i32,
    zoom: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
) -> String {
    let zoom_key = format!("{zoom:.3}");
    format!(
        "{}_{}_{}_{}_{}_{}_{}_{}_{}_{}_{}_{}",
        TILE_RENDER_CACHE_VERSION,
        file_path,
        file_identity.size,
        file_identity.modified_nanos,
        file_identity.created_nanos.unwrap_or(0),
        page,
        zoom_key,
        rotation,
        clip_x.unwrap_or(0),
        clip_y.unwrap_or(0),
        clip_w.unwrap_or(0),
        clip_h.unwrap_or(0)
    )
}

struct DocHandle {
    // Cache page ĐÃ MỞ (LRU) để pdfium TÁI DÙNG ảnh đã giải nén giữa các lần render
    // (re-render/zoom/thumbnail rớt từ ~600ms → ~120ms cho trang nhiều ảnh nặng).
    // Khai báo `pages` trước `doc` để khi drop, mọi FPDF_PAGE đóng trước FPDF_DOCUMENT.
    pages: Mutex<PageLru>,
    lock: Mutex<()>,
    doc: PdfDocument<'static>,
}

// LRU các PdfPage đang mở. Mỗi page giữ ảnh đã giải nén (~16MB với file bình nặng).
// PERF (audit 2026-08-08 §RENDER.9): máy >=16GB giữ nguyên cap 24; chỉ hai tier RAM
// thấp giảm để nhiều tab không đẩy máy vào swap. Không xác định RAM cũng giữ full.
const PAGE_LRU_CAP_LOW_RAM: usize = 6;
const PAGE_LRU_CAP_MID_RAM: usize = 12;
const PAGE_LRU_CAP_FULL: usize = 24;

fn page_lru_cap_for_total_ram(total_bytes: Option<u64>) -> usize {
    match total_bytes {
        Some(bytes) if bytes < 8 * GIB => PAGE_LRU_CAP_LOW_RAM,
        Some(bytes) if bytes < 16 * GIB => PAGE_LRU_CAP_MID_RAM,
        _ => PAGE_LRU_CAP_FULL,
    }
}

fn configured_page_lru_cap() -> usize {
    page_lru_cap_for_total_ram(system_total_memory_bytes())
}
struct PageLru {
    map: HashMap<u16, PdfPage<'static>>,
    order: std::collections::VecDeque<u16>,
    max: usize,
}
impl PageLru {
    fn new(max: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: std::collections::VecDeque::new(),
            max,
        }
    }
}

// PERF (audit 2026-08-02 §LOAD.3): LRU tài liệu tách khỏi PDFium để test được
// lifecycle/cache thuần Rust. `None` nghĩa là không cap trên máy >=16GB; đóng tab vẫn
// chủ động remove entry nên máy mạnh không bị giảm công suất mà handle không sống vô hạn.
struct DocumentCache<T> {
    map: HashMap<String, T>,
    order: VecDeque<String>,
    max_entries: Option<usize>,
}

impl<T> DocumentCache<T> {
    fn new(max_entries: Option<usize>) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            max_entries,
        }
    }

    fn get_cloned(&mut self, key: &str) -> Option<T>
    where
        T: Clone,
    {
        if !self.map.contains_key(key) {
            return None;
        }
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.to_string());
        self.map.get(key).cloned()
    }

    /// Trả các entry bị thay/evict để caller drop SAU KHI đã nhả mutex cache.
    fn insert(&mut self, key: String, value: T) -> Vec<T> {
        let mut removed = Vec::new();
        self.order.retain(|candidate| candidate != &key);
        if let Some(previous) = self.map.insert(key.clone(), value) {
            removed.push(previous);
        }
        self.order.push_back(key);

        if let Some(max_entries) = self.max_entries {
            while self.map.len() > max_entries {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                if let Some(evicted) = self.map.remove(&oldest) {
                    removed.push(evicted);
                }
            }
        }
        removed
    }

    fn remove(&mut self, key: &str) -> Option<T> {
        self.order.retain(|candidate| candidate != key);
        self.map.remove(key)
    }
}

struct CachedDocument {
    pool: Vec<OnceLock<DocHandle>>,
    user_units: Vec<f32>,
    page_lru_cap: usize,
    // PERF (audit 2026-08-10 §PPE.REAUDIT.1): summary bootstrap là snapshot riêng:
    // trang 1 đã quét thật, trang chưa quét fail-closed. Không được coi nó là metadata đầy đủ.
    bootstrap_color_risk: pdf_color_risk::PdfColorRiskSummary,
    // PERF (audit 2026-08-08 §RENDER.1): detector toàn tài liệu không thuộc đường
    // first-pixel. Viewer bootstrap để trống và pha metadata nền mới điền một lần.
    color_risk: Mutex<Option<pdf_color_risk::PdfColorRiskSummary>>,
    file_identity: PdfFileIdentity,
    next: AtomicUsize, // Round-robin index
}

impl CachedDocument {
    fn user_unit(&self, page_index: u16) -> Result<f32, String> {
        self.user_units
            .get(page_index as usize)
            .copied()
            .ok_or_else(|| {
                format!(
                    "Thiếu /UserUnit đã kiểm chứng cho trang {}.",
                    page_index as usize + 1
                )
            })
    }
}

impl Drop for CachedDocument {
    fn drop(&mut self) {
        // FPDF_ClosePage/FPDF_CloseDocument cũng chạm PDFium. Drop dưới cả hai khóa và
        // lấy đúng thứ tự LOAD -> RENDER như đường mở tài liệu để không đua với load/in.
        let _load_guard = lock_mutex(&LOAD_LOCK);
        let _render_guard = lock_mutex(&RENDER_LOCK);
        let pool = std::mem::take(&mut self.pool);
        drop(pool);
    }
}
unsafe impl Send for CachedDocument {}
unsafe impl Sync for CachedDocument {}
unsafe impl Send for DocHandle {}
unsafe impl Sync for DocHandle {}

struct SyncPdfium(&'static Pdfium);
unsafe impl Send for SyncPdfium {}
unsafe impl Sync for SyncPdfium {}

static PDFIUM_STATIC: OnceLock<SyncPdfium> = OnceLock::new();
static PDFIUM_LIBRARY_IDENTITY: OnceLock<PdfiumRuntimeIdentity> = OnceLock::new();
static DOC_CACHE: OnceLock<Mutex<DocumentCache<Arc<CachedDocument>>>> = OnceLock::new();

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfiumRuntimeIdentity {
    library_path: String,
    size_bytes: Option<u64>,
    modified_millis: Option<u64>,
    app_version: &'static str,
    tile_cache_version: &'static str,
}

fn pdfium_runtime_identity_for_path(path: &std::path::Path) -> PdfiumRuntimeIdentity {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let metadata = std::fs::metadata(&resolved).ok();
    let modified_millis = metadata
        .as_ref()
        .and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64);
    PdfiumRuntimeIdentity {
        library_path: resolved.to_string_lossy().into_owned(),
        size_bytes: metadata.as_ref().map(std::fs::Metadata::len),
        modified_millis,
        app_version: env!("CARGO_PKG_VERSION"),
        tile_cache_version: TILE_RENDER_CACHE_VERSION,
    }
}

fn current_pdfium_runtime_identity() -> PdfiumRuntimeIdentity {
    PDFIUM_LIBRARY_IDENTITY
        .get()
        .cloned()
        .unwrap_or(PdfiumRuntimeIdentity {
            library_path: "unknown".to_string(),
            size_bytes: None,
            modified_millis: None,
            app_version: env!("CARGO_PKG_VERSION"),
            tile_cache_version: TILE_RENDER_CACHE_VERSION,
        })
}

const DEFAULT_PDF_USER_UNIT: f32 = 1.0;
const MAX_PDF_USER_UNIT: f32 = 75_000.0;
const MIB: usize = 1024 * 1024;
const LOW_RAM_LOPDF_STREAM_LIMIT: usize = 64 * MIB;
const MID_RAM_LOPDF_STREAM_LIMIT: usize = 256 * MIB;

fn valid_pdf_user_unit(value: &lopdf::Object, document: &lopdf::Document) -> Option<f32> {
    let (_, resolved) = document.dereference(value).ok()?;
    let user_unit = resolved.as_float().ok()?;
    (user_unit.is_finite() && user_unit > 0.0 && user_unit <= MAX_PDF_USER_UNIT)
        .then_some(user_unit)
}

fn collect_pdf_user_units(document: &lopdf::Document) -> Vec<f32> {
    document
        .get_pages()
        .values()
        .map(|page_id| {
            document
                .get_dictionary(*page_id)
                .ok()
                .and_then(|page| page.get(b"UserUnit").ok())
                .and_then(|value| valid_pdf_user_unit(value, document))
                .unwrap_or(DEFAULT_PDF_USER_UNIT)
        })
        .collect()
}

fn lopdf_decompression_limit_for_total_ram(total_bytes: Option<u64>) -> Option<usize> {
    match total_bytes {
        Some(bytes) if bytes < 8 * GIB => Some(LOW_RAM_LOPDF_STREAM_LIMIT),
        Some(bytes) if bytes < 16 * GIB => Some(MID_RAM_LOPDF_STREAM_LIMIT),
        // PERF (audit 2026-08-04 §W1.PB6): máy >=16GB giữ nguyên toàn năng;
        // không xác định được RAM cũng không tự ý hạ khả năng đọc PDF hợp lệ.
        _ => None,
    }
}

fn lopdf_load_options_for_total_ram(total_bytes: Option<u64>) -> lopdf::LoadOptions {
    lopdf::LoadOptions {
        max_decompressed_size: lopdf_decompression_limit_for_total_ram(total_bytes),
        ..Default::default()
    }
}

#[derive(Debug)]
struct ParsedPdfStructure {
    user_units: Vec<f32>,
    color_risk: pdf_color_risk::PdfColorRiskSummary,
}

#[derive(Debug)]
struct ParsedPdfBootstrapStructure {
    user_units: Vec<f32>,
    bootstrap_color_risk: pdf_color_risk::PdfColorRiskSummary,
}

fn load_lopdf_structure(bytes: &[u8], total_bytes: Option<u64>) -> Result<lopdf::Document, String> {
    lopdf::Document::load_mem_with_options(bytes, lopdf_load_options_for_total_ram(total_bytes))
        .map_err(|error| {
            format!("Không thể đọc cấu trúc trang PDF an toàn để xác định /UserUnit: {error}")
        })
}

fn parse_pdf_structure(
    bytes: &[u8],
    total_bytes: Option<u64>,
) -> Result<ParsedPdfStructure, String> {
    // PAGEBOX (audit 2026-08-04 §W1.PB6): parse ngay trên buffer sẽ chuyển cho
    // PDFium; Document lopdf được drop trước khi PDFium mở để không giữ hai bản PDF.
    let document = load_lopdf_structure(bytes, total_bytes)?;
    // COLOR (audit 2026-08-07 §GV.3): tận dụng cùng lần parse để nhận diện trang
    // CMYK/DeviceN/transparency; không đọc file lần hai và không giải mã bitmap.
    Ok(ParsedPdfStructure {
        user_units: collect_pdf_user_units(&document),
        color_risk: pdf_color_risk::analyze_pdf_color_risk(&document),
    })
}

fn parse_pdf_bootstrap_structure(
    bytes: &[u8],
    total_bytes: Option<u64>,
) -> Result<ParsedPdfBootstrapStructure, String> {
    // PERF (audit 2026-08-10 §PPE.REAUDIT.1): giữ kiểm `/UserUnit` cho mọi trang,
    // nhưng chỉ quét risk thật ở trang đầu. Các trang còn lại được đánh dấu bảo thủ
    // cho tới khi pha metadata nền trả kết quả đầy đủ.
    let document = load_lopdf_structure(bytes, total_bytes)?;
    Ok(ParsedPdfBootstrapStructure {
        user_units: collect_pdf_user_units(&document),
        bootstrap_color_risk: pdf_color_risk::analyze_pdf_color_risk_bootstrap(&document),
    })
}

fn validate_pdf_user_unit_page_count(
    user_units: Vec<f32>,
    pdfium_page_count: usize,
) -> Result<Vec<f32>, String> {
    if user_units.len() != pdfium_page_count {
        return Err(format!(
            "Số trang PDF không nhất quán giữa bộ đọc cấu trúc ({}) và bộ hiển thị ({}); từ chối hiển thị để tránh sai kích thước.",
            user_units.len(),
            pdfium_page_count
        ));
    }
    Ok(user_units)
}

fn physical_page_dimension(raw_points: f32, user_unit: f32, fallback_points: f32) -> f32 {
    if raw_points.is_finite() && raw_points >= 1.0 {
        raw_points * user_unit
    } else {
        fallback_points
    }
}

fn viewer_render_scale(zoom: f32, user_unit: f32) -> f32 {
    let mut render_scale = (96.0 / 72.0) * zoom * user_unit;
    if !render_scale.is_finite() {
        render_scale = 1.0;
    }
    render_scale.max(0.01)
}

fn collect_physical_page_dimensions<F>(
    page_count: u16,
    user_units: &[f32],
    fallback_width: f32,
    fallback_height: f32,
    mut page_size: F,
) -> Result<Vec<(f32, f32)>, String>
where
    F: FnMut(u16) -> Option<(f32, f32)>,
{
    if user_units.len() != page_count as usize {
        return Err("Bảng /UserUnit không khớp số trang PDF.".to_string());
    }

    Ok((0..page_count)
        .map(|page_index| match page_size(page_index) {
            Some((raw_width, raw_height)) => {
                let user_unit = user_units[page_index as usize];
                (
                    physical_page_dimension(raw_width, user_unit, 595.0),
                    physical_page_dimension(raw_height, user_unit, 842.0),
                )
            }
            None => (fallback_width, fallback_height),
        })
        .collect())
}

/// Bind thư viện pdfium MỘT LẦN (OnceLock). Tách hàm để vừa dùng trong các lệnh
/// Tìm & bind pdfium.dll. Thử các đường dẫn TUYỆT ĐỐI cạnh executable trước
/// (release: working-dir là thư mục cài đặt, không phải thư mục exe → "./bin/" sai),
/// sau đó mới tới đường dẫn tương đối (dev) và system library.
fn bind_pdfium() -> Result<Box<dyn PdfiumLibraryBindings>, String> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf()); // <exe_dir>/pdfium.dll
            dirs.push(parent.join("bin")); // <exe_dir>/bin/pdfium.dll (resource bundle)
        }
    }
    dirs.push(std::path::PathBuf::from("./bin")); // dev: working-dir = src-tauri
    dirs.push(std::path::PathBuf::from("."));
    for dir in &dirs {
        let lib = Pdfium::pdfium_platform_library_name_at_path(dir);
        if let Ok(bindings) = Pdfium::bind_to_library(&lib) {
            let identity = pdfium_runtime_identity_for_path(&lib);
            log::info!(
                "[PDFIUM] library='{}' bytes={:?} modified_ms={:?}",
                identity.library_path,
                identity.size_bytes,
                identity.modified_millis
            );
            let _ = PDFIUM_LIBRARY_IDENTITY.set(identity);
            return Ok(bindings);
        }
    }
    match Pdfium::bind_to_system_library() {
        Ok(bindings) => {
            let _ = PDFIUM_LIBRARY_IDENTITY.set(PdfiumRuntimeIdentity {
                library_path: "system-library-search".to_string(),
                size_bytes: None,
                modified_millis: None,
                app_version: env!("CARGO_PKG_VERSION"),
                tile_cache_version: TILE_RENDER_CACHE_VERSION,
            });
            Ok(bindings)
        }
        Err(error) => Err(format!(
            "Khong tim thay pdfium.dll (da thu canh exe, ./bin va system): {:?}",
            error
        )),
    }
}

/// Bind thư viện pdfium MỘT LẦN. Trả về Result để KHÔNG panic khi không tìm thấy
/// dll (panic trong spawn_blocking sẽ làm task render crash → "Task panicked").
pub fn ensure_pdfium() -> Result<&'static Pdfium, String> {
    if let Some(p) = PDFIUM_STATIC.get() {
        return Ok(p.0);
    }
    let bindings = bind_pdfium()?;
    let leaked: &'static Pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
    // Nếu thread khác đã set trước (race), bản leaked này bị bỏ qua (rò rỉ nhỏ, vô hại).
    let _ = PDFIUM_STATIC.set(SyncPdfium(leaked));
    Ok(PDFIUM_STATIC
        .get()
        .map(|s| s.0)
        .ok_or_else(|| "PDFium OnceLock empty".to_string())?)
}

/// Mutex lock không panic khi poisoned (thread trước panic) — recover guard.
pub fn lock_mutex<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| {
        log::error!("[LOCK] mutex poisoned — recovering (thread trước đã panic)");
        poisoned.into_inner()
    })
}

/// Entry print worker (gọi từ main khi --prynx-print-job).
pub fn run_print_worker(job_path: &str, result_path: &str) -> i32 {
    pdf_engine::print_worker::run_print_worker(job_path, result_path)
}

/// Entry display worker dài hạn (gọi từ main khi --prynx-render-worker).
pub fn run_render_worker_stdio() -> i32 {
    pdf_engine::render_worker::run_worker_stdio()
}

/// Breadcrumb khởi động → %APPDATA%\PrynX\logs\startup_debug.log
fn startup_breadcrumb(msg: &str) {
    #[cfg(debug_assertions)]
    {
        log::info!("[STARTUP] {}", msg);
        if let Ok(appdata) = std::env::var("APPDATA") {
            let dir = std::path::Path::new(&appdata).join("PrynX").join("logs");
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("startup_debug.log"))
            {
                use std::io::Write;
                let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                let _ = writeln!(f, "[{}] {}", now, msg);
            }
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = msg;
}

fn reveal_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Không tìm thấy cửa sổ chính của PrynX".to_string())?;
    // UIUX (feedback 2026-08-11 §WINDOW.RESTORE): cửa sổ được tạo ẩn có thể còn
    // mang trạng thái minimized từ Windows. Chuẩn hóa trước khi show để taskbar
    // luôn có một cửa sổ khôi phục được, kể cả sau Alt+Tab.
    main_window
        .unminimize()
        .map_err(|error| format!("Không khôi phục được cửa sổ chính: {error}"))?;
    main_window
        .show()
        .map_err(|error| format!("Không hiện được cửa sổ chính: {error}"))?;
    APP_STARTUP_READY.store(true, Ordering::Release);
    if let Err(error) = main_window.set_focus() {
        log::warn!("[STARTUP] Không focus được cửa sổ chính: {}", error);
    }
    if let Some(startup_window) = app.get_webview_window("startup") {
        if let Err(error) = startup_window.close() {
            log::warn!("[STARTUP] Không đóng được splash: {}", error);
        }
    }
    startup_breadcrumb("setup complete — app ready");
    Ok(())
}

#[tauri::command]
fn mark_frontend_interactive() {
    if !FRONTEND_INTERACTIVE_RECORDED.swap(true, Ordering::AcqRel) {
        // PERF (audit 2026-08-05 §PERF.5): mốc cuối do React gửi sau khi Home mount.
        startup_breadcrumb("frontend: Home interactive");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// [PROC-LIFECYCLE FIX 2026-08-28 §UP.6] Canh "chỉ một instance app thật sự chạy".
//
// tauri-plugin-single-instance 2.4.2 có một lỗ: khi mutex của nó ĐÃ tồn tại nhưng
// `FindWindowW` không thấy cửa sổ ẩn của instance kia (instance đó đang treo, hoặc cửa sổ
// đã bị hủy), plugin **đi tiếp** — và đi tiếp mà KHÔNG giữ mutex, KHÔNG tạo cửa sổ đích.
// Từ đó nhiều instance đầy đủ cùng chạy. Hậu quả cụ thể trong PrynX trước đây là mỗi
// cold-start đều cố `taskkill /IM pdf-inspector-backend.exe /F` để dọn zombie, nên instance
// mới có thể GIẾT SIDECAR của instance đang dùng; supervisor bên kia thấy listener lạ rồi
// `Stop` — backend chết hẳn trong phiên đó.
//
// Ta không vá được crate vendor, nhưng chặn được phần phá hoại: giữ một mutex RIÊNG (tên
// khác hẳn của plugin — trùng tên là làm sập luôn cơ chế của plugin ở instance đầu tiên) chỉ
// để biết "đã có tiến trình app PrynX khác đang sống". Nếu cờ này bật mà ta VẪN chạy tới
// setup, nghĩa là plugin đã không forward được và không exit ta ⇒ instance kia đang treo ⇒
// từ chối khởi động thay vì phá sidecar của nó.
static SECONDARY_INSTANCE: AtomicBool = AtomicBool::new(false);

fn claim_primary_instance_mutex() {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    let name = "com.prynx.app-primary-instance-guard\0"
        .encode_utf16()
        .collect::<Vec<u16>>();
    unsafe {
        match CreateMutexW(None, true, PCWSTR(name.as_ptr())) {
            Ok(_handle) => {
                // windows-rs chỉ gọi GetLastError khi handle không hợp lệ, nên mã lỗi của
                // CreateMutexW vẫn còn nguyên ở đây — đúng cách plugin vendor cũng dùng.
                let already_running = GetLastError() == ERROR_ALREADY_EXISTS;
                SECONDARY_INSTANCE.store(already_running, Ordering::Release);
                if already_running {
                    log::warn!("[INSTANCE] Đã có tiến trình PrynX khác đang chạy.");
                }
                // KHÔNG CloseHandle: mutex phải sống bằng tuổi tiến trình vì nó chính là dấu
                // hiệu "app còn sống". HANDLE không có Drop nên chỉ cần không đóng tay.
            }
            Err(error) => {
                // Không dựng được mutex thì giữ nguyên hành vi cũ, không chặn khởi động.
                log::warn!("[INSTANCE] Không tạo được mutex canh instance: {error}");
            }
        }
    }
}

/// [PROC-LIFECYCLE FIX 2026-08-28 §UP.5/§UP.8] Dựng lệnh PowerShell hiện hộp thoại lỗi
/// khởi động, mỗi phần tử `paragraphs` là một đoạn.
///
/// Hai ràng buộc đã trả giá, đừng "đơn giản hóa" lại:
/// 1. **ASCII không dấu.** Tham số truyền qua dòng lệnh PowerShell làm hỏng ký tự có dấu —
///    mọi thông điệp khởi động trong file này vì thế viết không dấu.
/// 2. **Chỉ dùng nháy đơn, ngắt dòng bằng `[char]10`.** Chuỗi nháy đơn của PowerShell KHÔNG
///    nội suy nên `$([char]10)` sẽ hiện nguyên văn; còn dùng nháy kép thì phải đấu với cách
///    Windows quote tham số (`std::process::Command` escape `"` thành `\"`, PowerShell.exe
///    xử lý chuỗi đó không đáng tin). Ghép bằng toán tử `+` là đường an toàn duy nhất.
// Chỉ tồn tại ở bản release (nơi có hộp thoại) và trong test — cùng khuôn cfg với các helper
// release-only khác trong file này, để bản debug không sinh warning dead_code.
#[cfg(any(test, not(debug_assertions)))]
fn build_startup_error_command(paragraphs: &[&str]) -> String {
    let joined = paragraphs
        .iter()
        .map(|part| format!("'{}'", part.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(" + [char]10 + [char]10 + ");
    format!("[System.Windows.MessageBox]::Show({joined}, 'PrynX', 'OK', 'Error')")
}

#[cfg(not(debug_assertions))]
fn show_startup_error_dialog(paragraphs: &[&str]) {
    // SEC (audit 2026-09-04 §SEC.24-R1): mọi dialog release dùng đúng binary
    // Windows do System32 trả về; không cho môi trường cha thay bằng PATH giả.
    let Ok(powershell) = security::system_powershell_path() else {
        return;
    };
    let _ = std::process::Command::new(powershell)
        .args([
            "-NoProfile",
            "-Command",
            &build_startup_error_command(paragraphs),
        ])
        .creation_flags(0x08000000)
        .output();
}

#[cfg(test)]
mod startup_dialog_tests {
    use super::build_startup_error_command;

    #[test]
    fn ghep_doan_bang_char_10_va_escape_nhay_don() {
        let command = build_startup_error_command(&["Doan mot", "Doan 'hai'"]);
        assert_eq!(
            command,
            "[System.Windows.MessageBox]::Show('Doan mot' + [char]10 + [char]10 + \
             'Doan ''hai''', 'PrynX', 'OK', 'Error')"
        );
        // Không được lọt nháy kép: đó là dấu hiệu quay lại đường escape không đáng tin.
        assert!(!command.contains('"'));
    }

    #[test]
    fn mot_doan_thi_khong_them_ngat_dong() {
        assert_eq!(
            build_startup_error_command(&["Chi mot doan"]),
            "[System.Windows.MessageBox]::Show('Chi mot doan', 'PrynX', 'OK', 'Error')"
        );
    }
}

/// [PROC-LIFECYCLE FIX 2026-08-28 §UP.3] Dọn tiến trình con NGAY TRƯỚC khi chạy trình cài
/// bản mới. Frontend phải gọi command này giữa `update.download()` và `update.install()`.
///
/// Vì sao không làm trong `RunEvent::Exit`: `install()` của tauri-plugin-updater kết thúc
/// bằng `std::process::exit(0)` sau khi ShellExecute trình cài. Hook duy nhất plugin gọi
/// trước đó là `cleanup_before_exit()`, và hàm đó CHỈ clear resource table + ẩn cửa sổ —
/// nó KHÔNG phát `RunEvent::Exit`. Nghĩa là chốt dọn duy nhất của app (xem cuối `run()`)
/// không bao giờ chạy trên đường cập nhật, và sidecar + display worker vẫn giữ handle
/// trong thư mục cài đặt đúng lúc NSIS ghi đè file. Audit 2026-08-28 §UP.3.
///
/// Thứ tự trong hàm là có chủ ý: bật cờ shutdown trước để supervisor không respawn, diệt
/// sidecar (việc quan trọng nhất cho trình cài) rồi mới dọn display worker.
#[tauri::command]
fn prepare_for_update(window: tauri::WebviewWindow) -> Result<(), String> {
    // SEC (pentest 2026-08-28 §ATK.11): chỉ cửa sổ "main" — nơi UI updater
    // (UpdateChecker/AboutModal) thật sự sống — được kích lệnh này. Cửa sổ tài liệu PDF
    // nhân bản (label "document-*") và mọi webview phụ KHÔNG được diệt sidecar + chặn
    // respawn (DoS cục bộ: backend chết tới khi mở lại app). Đây là thu hẹp bề mặt theo
    // least-privilege; KHÔNG chặn được XSS ngay trong "main" vì renderer main có toàn
    // quyền frontend (trần Ring-3, cùng lớp §ATK.10). KHÔNG tự phục hồi được bằng cách
    // nới SIDECAR_SHUTDOWN vì tính TIN CẬY của bản cập nhật (§UP.3/§UP.7) phụ thuộc đúng
    // vào việc chặn respawn vĩnh viễn để NSIS ghi đè được file — nới ra sẽ hồi quy lỗi đó.
    if window.label() != "main" {
        log::warn!(
            "[UPDATE][§ATK.11] Bỏ qua prepare_for_update từ cửa sổ không phải main: {}",
            window.label()
        );
        return Err("Chỉ cửa sổ chính được phép chuẩn bị cập nhật".to_string());
    }
    cleanup_children_before_installer()
}

// Cache LRU tile trong RAM. Dung lượng JPEG thay đổi rất rộng theo kích thước/nội dung,
// nên giới hạn theo số ảnh không phản ánh lượng RAM thật đang giữ.
struct TileCache {
    map: HashMap<String, Vec<u8>>,
    queue: std::collections::VecDeque<String>,
    max_bytes: Option<usize>,
    current_bytes: usize,
}
impl TileCache {
    fn new(max_bytes: Option<usize>) -> Self {
        Self {
            map: HashMap::new(),
            queue: std::collections::VecDeque::new(),
            max_bytes,
            current_bytes: 0,
        }
    }
    fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        if self.map.contains_key(key) {
            self.queue.retain(|k| k != key);
            self.queue.push_back(key.to_string());
            self.map.get(key).cloned()
        } else {
            None
        }
    }
    fn insert(&mut self, key: String, data: Vec<u8>) {
        if let Some(previous) = self.map.remove(&key) {
            self.current_bytes = self.current_bytes.saturating_sub(previous.len());
            self.queue.retain(|cached_key| cached_key != &key);
        }

        if let Some(max_bytes) = self.max_bytes {
            // Một tile đơn lẻ lớn hơn toàn bộ budget vẫn được trả cho caller nhưng
            // không giữ lại, tránh một entry phá vỡ giới hạn RAM của máy yếu.
            if data.len() > max_bytes {
                return;
            }
            while self.current_bytes.saturating_add(data.len()) > max_bytes {
                let Some(oldest) = self.queue.pop_front() else {
                    break;
                };
                if let Some(removed) = self.map.remove(&oldest) {
                    self.current_bytes = self.current_bytes.saturating_sub(removed.len());
                }
            }
        }

        self.current_bytes = self.current_bytes.saturating_add(data.len());
        self.queue.push_back(key.clone());
        self.map.insert(key, data);
    }
}
static TILE_CACHE: OnceLock<Mutex<TileCache>> = OnceLock::new();
pub(crate) static LOAD_LOCK: Mutex<()> = Mutex::new(());
// PDFium KHÔNG thread-safe kể cả trên các FPDF_DOCUMENT khác nhau (font cache & state
// toàn cục dùng chung). Render tile giữ handle.lock PER-DOC nên 2 tab có thể render song
// song; đường in (print.rs) mở doc RIÊNG qua FFI, nằm ngoài DOC_CACHE nên không bị
// handle.lock chặn → có thể render đè lên tile → crash. RENDER_LOCK serialize MỌI thao
// tác render PDFium (tile + in). Chỉ bọc quanh chính lệnh render, KHÔNG giữ khi mở
// PrintDlg (tránh treo viewer suốt lúc hộp thoại mở).
pub static RENDER_LOCK: Mutex<()> = Mutex::new(());

const GIB: u64 = 1024 * 1024 * 1024;

fn tile_cache_budget_for_total_ram(total_bytes: Option<u64>) -> Option<usize> {
    match total_bytes {
        Some(bytes) if bytes < 8 * GIB => Some(64 * MIB),
        Some(bytes) if bytes < 16 * GIB => Some(128 * MIB),
        // PERF (audit 2026-08-05 §PERF.7): máy >=16 GB giữ full cache như policy
        // dự án; máy không đọc được RAM cũng không bị áp cap bảo thủ ngoài ý muốn.
        _ => None,
    }
}

fn parse_tile_cache_budget_override(raw: Option<&str>) -> Option<Option<usize>> {
    let value_mb = raw?.trim().parse::<usize>().ok()?;
    if value_mb == 0 {
        return Some(None);
    }
    value_mb.checked_mul(MIB).map(Some)
}

fn configured_tile_cache_budget() -> Option<usize> {
    if let Ok(raw) = std::env::var("PRYNX_TILE_CACHE_MB") {
        if let Some(budget) = parse_tile_cache_budget_override(Some(&raw)) {
            return budget;
        }
        log::warn!("[TILE_CACHE] Bỏ qua PRYNX_TILE_CACHE_MB không hợp lệ: {raw}");
    }
    tile_cache_budget_for_total_ram(system_total_memory_bytes())
}

fn tile_cache() -> &'static Mutex<TileCache> {
    TILE_CACHE.get_or_init(|| {
        let budget = configured_tile_cache_budget();
        let policy = budget
            .map(|bytes| format!("{} MiB", bytes / MIB))
            .unwrap_or_else(|| "unbounded".to_string());
        log::info!("[TILE_CACHE] policy={policy}");
        // Chỉ binary dev có PRYNX_PERF=1 mới ghi; release không có đường bật lại.
        perf_log(&format!("TILE_CACHE_POLICY budget={policy}"));
        Mutex::new(TileCache::new(budget))
    })
}

fn doc_cache_limit_for_total_ram(total_bytes: Option<u64>) -> Option<usize> {
    match total_bytes {
        Some(bytes) if bytes < 8 * GIB => Some(2),
        Some(bytes) if bytes < 16 * GIB => Some(4),
        // PERF (audit 2026-08-02 §LOAD.3): máy >=16GB không hard-cap; lifecycle tab
        // vẫn đóng document chủ động. Không xác định được RAM cũng chọn không giảm.
        _ => None,
    }
}

// PERF (audit 2026-08-02 §B.1): đưa cả RAM tổng và RAM khả dụng sang frontend để
// Combine chỉ điều chỉnh khi máy thật sự thiếu bộ nhớ; command này không áp hard-cap.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemMemoryStatus {
    installed_bytes: u64,
    total_bytes: u64,
    usable_bytes: u64,
    available_bytes: u64,
}

#[cfg(target_os = "windows")]
fn system_memory_status() -> Option<SystemMemoryStatus> {
    use windows::Win32::System::SystemInformation::{
        GetPhysicallyInstalledSystemMemory, GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
    let installed_bytes = {
        let mut installed_kib = 0_u64;
        unsafe { GetPhysicallyInstalledSystemMemory(&mut installed_kib) }
            .ok()
            .and_then(|()| installed_kib.checked_mul(1024))
            .filter(|bytes| *bytes >= status.ullTotalPhys)
            .unwrap_or(status.ullTotalPhys)
    };
    Some(SystemMemoryStatus {
        // PERF (audit 2026-08-06 §PERF.5): giữ `totalBytes` là RAM lắp đặt để
        // consumer cũ không xếp máy 16 GB thành <16 GB vì hardware-reserved RAM.
        installed_bytes,
        total_bytes: installed_bytes,
        usable_bytes: status.ullTotalPhys,
        available_bytes: status.ullAvailPhys,
    })
}

#[cfg(not(target_os = "windows"))]
fn system_memory_status() -> Option<SystemMemoryStatus> {
    None
}

fn system_total_memory_bytes() -> Option<u64> {
    system_memory_status().map(|status| status.total_bytes)
}

#[tauri::command]
fn get_system_memory_status() -> Result<SystemMemoryStatus, String> {
    system_memory_status().ok_or_else(|| "Không đọc được trạng thái bộ nhớ hệ thống.".to_string())
}

// UIUX (feedback 2026-08-11 §VIEW.ACTUAL-SIZE): 100% phải là kích thước vật lý,
// không phải mặc định 96 CSS px/in trên mọi màn hình. Raw DPI lấy theo đúng monitor
// chứa cửa sổ; frontend tự chia DPR để ra số CSS pixel trên một inch.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentDisplayMetrics {
    monitor_id: String,
    monitor_name: Option<String>,
    raw_dpi_x: Option<u32>,
    raw_dpi_y: Option<u32>,
    scale_factor: f64,
    width_px: u32,
    height_px: u32,
}

#[cfg(target_os = "windows")]
fn raw_dpi_for_window(window: &tauri::WebviewWindow) -> Option<(u32, u32)> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_RAW_DPI};

    let raw_hwnd = window.hwnd().ok()?.0;
    let hwnd = HWND(raw_hwnd as *mut std::ffi::c_void);
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.0.is_null() {
        return None;
    }

    let mut dpi_x = 0_u32;
    let mut dpi_y = 0_u32;
    unsafe { GetDpiForMonitor(monitor, MDT_RAW_DPI, &mut dpi_x, &mut dpi_y) }.ok()?;
    if dpi_x == 0 || dpi_y == 0 {
        return None;
    }
    Some((dpi_x, dpi_y))
}

#[cfg(not(target_os = "windows"))]
fn raw_dpi_for_window(_window: &tauri::WebviewWindow) -> Option<(u32, u32)> {
    None
}

#[tauri::command]
fn get_current_display_metrics(
    window: tauri::WebviewWindow,
) -> Result<CurrentDisplayMetrics, String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("Không đọc được màn hình hiện tại: {error}"))?;
    let fallback_scale = window.scale_factor().unwrap_or(1.0);
    let (monitor_name, width_px, height_px, position_x, position_y, scale_factor) =
        if let Some(monitor) = monitor {
            (
                monitor.name().cloned(),
                monitor.size().width,
                monitor.size().height,
                monitor.position().x,
                monitor.position().y,
                monitor.scale_factor(),
            )
        } else {
            (None, 0, 0, 0, 0, fallback_scale)
        };
    let (raw_dpi_x, raw_dpi_y) = raw_dpi_for_window(&window)
        .map(|(x, y)| (Some(x), Some(y)))
        .unwrap_or((None, None));
    let monitor_id = format!(
        "{}:{}x{}@{},{}",
        monitor_name.as_deref().unwrap_or("unknown"),
        width_px,
        height_px,
        position_x,
        position_y,
    );

    Ok(CurrentDisplayMetrics {
        monitor_id,
        monitor_name,
        raw_dpi_x,
        raw_dpi_y,
        scale_factor,
        width_px,
        height_px,
    })
}

fn configured_doc_cache_limit() -> Option<usize> {
    if let Ok(raw) = std::env::var("PRYNX_DOC_CACHE_LIMIT") {
        if let Ok(value) = raw.trim().parse::<usize>() {
            return if value == 0 { None } else { Some(value) };
        }
    }
    doc_cache_limit_for_total_ram(system_total_memory_bytes())
}

fn document_cache() -> &'static Mutex<DocumentCache<Arc<CachedDocument>>> {
    DOC_CACHE.get_or_init(|| {
        let limit = configured_doc_cache_limit();
        log::info!(
            "[DOC_CACHE] policy={}",
            limit
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unbounded".to_string())
        );
        Mutex::new(DocumentCache::new(limit))
    })
}

fn read_pdf_bytes_for_identity(
    file_path: &str,
    expected_identity: PdfFileIdentity,
) -> Result<Vec<u8>, String> {
    let bytes =
        std::fs::read(file_path).map_err(|error| format!("Không đọc được file PDF: {error}"))?;
    let observed_identity = pdf_file_identity(file_path)?;
    if observed_identity != expected_identity || bytes.len() as u64 != expected_identity.size {
        return Err(
            "File PDF đã thay đổi trong lúc đang mở; vui lòng thử lại để tránh dùng dữ liệu cũ."
                .to_string(),
        );
    }
    Ok(bytes)
}

fn load_pdf_document_from_bytes(
    pdfium: &'static Pdfium,
    bytes: Vec<u8>,
) -> Result<PdfDocument<'static>, String> {
    // Buffer đã được parse /UserUnit và lopdf đã drop; chỉ còn một bản byte khi
    // chuyển quyền sở hữu sang PDFium.
    let _load_guard = lock_mutex(&LOAD_LOCK);
    let _pdfium_guard = lock_mutex(&RENDER_LOCK);
    pdfium
        .load_pdf_from_byte_vec(bytes, None)
        .map_err(|error| format!("Không mở được PDF bằng bộ hiển thị: {error:?}"))
}

fn drop_pdf_document_safely(document: PdfDocument<'static>) {
    let _load_guard = lock_mutex(&LOAD_LOCK);
    let _pdfium_guard = lock_mutex(&RENDER_LOCK);
    drop(document);
}

fn build_cached_document(
    pdfium: &'static Pdfium,
    file_path: &str,
    file_identity: PdfFileIdentity,
    include_color_risk: bool,
) -> Result<Arc<CachedDocument>, String> {
    // I/O và parse không giữ cache/PDFium mutex. Cùng buffer này được đọc đúng một
    // lần, parse bằng lopdf, drop parser rồi mới move vào PDFium để giảm peak RAM.
    let bytes = read_pdf_bytes_for_identity(file_path, file_identity)?;
    let (user_units, bootstrap_color_risk, color_risk) = if include_color_risk {
        let ParsedPdfStructure {
            user_units,
            color_risk,
        } = parse_pdf_structure(&bytes, system_total_memory_bytes())?;
        (user_units, color_risk.clone(), Some(color_risk))
    } else {
        let ParsedPdfBootstrapStructure {
            user_units,
            bootstrap_color_risk,
        } = parse_pdf_bootstrap_structure(&bytes, system_total_memory_bytes())?;
        (user_units, bootstrap_color_risk, None)
    };
    let doc = load_pdf_document_from_bytes(pdfium, bytes)?;
    let page_count = {
        let _pdfium_guard = lock_mutex(&RENDER_LOCK);
        doc.pages().len() as usize
    };
    let user_units = match validate_pdf_user_unit_page_count(user_units, page_count) {
        Ok(user_units) => user_units,
        Err(error) => {
            drop_pdf_document_safely(doc);
            return Err(error);
        }
    };
    let pool_size = get_doc_pool_size().max(1);
    let page_lru_cap = configured_page_lru_cap();
    let mut pool = Vec::with_capacity(pool_size);
    for _ in 0..pool_size {
        pool.push(OnceLock::new());
    }
    let _ = pool[0].set(DocHandle {
        pages: Mutex::new(PageLru::new(page_lru_cap)),
        lock: Mutex::new(()),
        doc,
    });
    Ok(Arc::new(CachedDocument {
        pool,
        user_units,
        page_lru_cap,
        bootstrap_color_risk,
        color_risk: Mutex::new(color_risk),
        file_identity,
        next: AtomicUsize::new(0),
    }))
}

fn ensure_cached_color_risk(
    document: &CachedDocument,
    file_path: &str,
) -> Result<pdf_color_risk::PdfColorRiskSummary, String> {
    // Khóa riêng detector, không giữ cache lock hay PDFium lock nên tile trang đầu vẫn
    // render được trong lúc pha metadata nền quét resources của toàn tài liệu.
    let mut cached = lock_mutex(&document.color_risk);
    if let Some(summary) = cached.as_ref() {
        return Ok(summary.clone());
    }

    let bytes = read_pdf_bytes_for_identity(file_path, document.file_identity)?;
    let ParsedPdfStructure { color_risk, .. } =
        parse_pdf_structure(&bytes, system_total_memory_bytes())?;
    if pdf_file_identity(file_path)? != document.file_identity {
        return Err(
            "File PDF đã thay đổi trong lúc phân tích màu; vui lòng thử lại để tải bản mới."
                .to_string(),
        );
    }
    *cached = Some(color_risk.clone());
    Ok(color_risk)
}

fn cached_document_for_identity(
    cache: &mut DocumentCache<Arc<CachedDocument>>,
    file_path: &str,
    file_identity: PdfFileIdentity,
) -> (Option<Arc<CachedDocument>>, Option<Arc<CachedDocument>>) {
    match cache.get_cloned(file_path) {
        Some(existing) if existing.file_identity == file_identity => (Some(existing), None),
        Some(_) => (None, cache.remove(file_path)),
        None => (None, None),
    }
}

fn get_or_load_cached_document_with_identity(
    pdfium: &'static Pdfium,
    file_path: &str,
    file_identity: PdfFileIdentity,
    include_color_risk: bool,
) -> Result<Arc<CachedDocument>, String> {
    let (existing, stale) = {
        let mut cache = lock_mutex(document_cache());
        cached_document_for_identity(&mut cache, file_path, file_identity)
    };
    // Document cùng path nhưng khác size/mtime phải đóng ngoài cache mutex.
    drop(stale);
    if let Some(existing) = existing {
        if include_color_risk {
            ensure_cached_color_risk(&existing, file_path)?;
        }
        return Ok(existing);
    }

    // Double-checked insert: đọc/parse file bên ngoài cache mutex. Hai request đua nhau
    // có thể cùng load; chỉ một entry cùng identity thắng.
    let candidate = build_cached_document(pdfium, file_path, file_identity, include_color_risk)?;
    if pdf_file_identity(file_path)? != file_identity {
        drop(candidate);
        return Err(
            "File PDF đã thay đổi trong lúc đang mở; vui lòng thử lại để tải bản mới.".to_string(),
        );
    }

    let mut cache = lock_mutex(document_cache());
    if let Some(existing) = cache.get_cloned(file_path) {
        drop(cache);
        drop(candidate);
        if existing.file_identity == file_identity {
            if include_color_risk {
                ensure_cached_color_risk(&existing, file_path)?;
            }
            return Ok(existing);
        }
        // Một request khác đã nạp identity mới hơn; không ghi đè ngược bằng bản cũ.
        return Err(
            "File PDF đã thay đổi trong lúc đang mở; vui lòng thử lại để tải bản mới.".to_string(),
        );
    }
    let removed = cache.insert(file_path.to_string(), Arc::clone(&candidate));
    drop(cache);
    drop(removed);
    Ok(candidate)
}

fn get_or_load_cached_document(
    pdfium: &'static Pdfium,
    file_path: &str,
) -> Result<Arc<CachedDocument>, String> {
    let file_identity = pdf_file_identity(file_path)?;
    get_or_load_cached_document_with_identity(pdfium, file_path, file_identity, false)
}

fn get_or_load_cached_document_with_color_risk(
    pdfium: &'static Pdfium,
    file_path: &str,
    file_identity: PdfFileIdentity,
) -> Result<(Arc<CachedDocument>, pdf_color_risk::PdfColorRiskSummary), String> {
    let document =
        get_or_load_cached_document_with_identity(pdfium, file_path, file_identity, true)?;
    let color_risk = ensure_cached_color_risk(&document, file_path)?;
    Ok((document, color_risk))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemFileBatch {
    batch_id: String,
    args: Vec<String>,
}

#[derive(Debug)]
struct SystemFilesInbox {
    startup: Option<SystemFileBatch>,
    pending: VecDeque<SystemFileBatch>,
    next_sequence: u64,
}

struct SystemFilesState(Mutex<SystemFilesInbox>);

impl SystemFilesState {
    fn new(startup_args: Vec<String>) -> Self {
        Self(Mutex::new(SystemFilesInbox {
            startup: Some(SystemFileBatch {
                batch_id: "startup-1".to_string(),
                args: startup_args,
            }),
            pending: VecDeque::new(),
            next_sequence: 2,
        }))
    }

    fn take_startup(&self) -> Option<SystemFileBatch> {
        lock_mutex(&self.0).startup.take()
    }

    fn enqueue(&self, args: Vec<String>) {
        let mut inbox = lock_mutex(&self.0);
        let batch_id = format!("instance-{}", inbox.next_sequence);
        inbox.next_sequence = inbox.next_sequence.saturating_add(1);
        inbox.pending.push_back(SystemFileBatch { batch_id, args });
    }

    fn drain_pending(&self) -> Vec<SystemFileBatch> {
        lock_mutex(&self.0).pending.drain(..).collect()
    }
}

#[cfg(test)]
mod system_files_inbox_tests {
    use super::SystemFilesState;

    #[test]
    fn startup_chi_duoc_lay_mot_lan_ke_ca_sau_reload_frontend() {
        let state =
            SystemFilesState::new(vec!["PrynX.exe".to_string(), "D:\\viec\\b.pdf".to_string()]);

        let first = state.take_startup().expect("phải có batch startup");
        assert_eq!(first.batch_id, "startup-1");
        assert_eq!(first.args[1], "D:\\viec\\b.pdf");
        assert!(state.take_startup().is_none());
    }

    #[test]
    fn moi_second_instance_giu_batch_va_thu_tu_rieng() {
        let state = SystemFilesState::new(vec!["PrynX.exe".to_string()]);
        state.enqueue(vec![
            "PrynX.exe".to_string(),
            "--prynx-action=combine".to_string(),
            "D:\\viec\\01.pdf".to_string(),
        ]);
        state.enqueue(vec![
            "PrynX.exe".to_string(),
            "--prynx-action=convert".to_string(),
            "D:\\viec\\02.png".to_string(),
        ]);

        let batches = state.drain_pending();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].batch_id, "instance-2");
        assert_eq!(batches[0].args[1], "--prynx-action=combine");
        assert_eq!(batches[1].batch_id, "instance-3");
        assert_eq!(batches[1].args[1], "--prynx-action=convert");
        assert!(state.drain_pending().is_empty());
    }
}

fn perf_env_value_enabled(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(|value| {
            value == "1"
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("yes")
                || value.eq_ignore_ascii_case("on")
        })
        .unwrap_or(false)
}

fn preview_perf_enabled_for_build(debug_build: bool, value: Option<&str>) -> bool {
    // SEC (audit 2026-09-05 §LOG.01): cờ môi trường chỉ có hiệu lực trong
    // binary dev. Người dùng máy khách không thể bật lại trace trên release.
    debug_build && perf_env_value_enabled(value)
}

fn preview_perf_enabled() -> bool {
    preview_perf_enabled_for_build(
        cfg!(debug_assertions),
        std::env::var("PRYNX_PERF").ok().as_deref(),
    )
}

#[tauri::command]
fn preview_perf_logging_enabled() -> bool {
    // PERF (audit 2026-08-05 §PERF.3): FE hỏi đúng một lần rồi cache kết quả;
    // SEC (audit 2026-09-05 §LOG.01): release luôn trả false.
    preview_perf_enabled()
}

// ── Đo hiệu năng render (đo thật, không đoán) ────────────────────────────────
// Đường log riêng cho render/thumbnail, set 1 lần trong setup(). KHÔNG dùng
// chrono::Local::now() (đã PANIC ở release trong render_tile_png_in_process — xem note ~:609)
// → dùng epoch millis từ SystemTime (không timezone, không panic). Chỉ bật khi
// binary dev đồng thời có env PRYNX_PERF=1; release bị khóa ở compile policy.
static PERF_LOG_PATH: OnceLock<std::path::PathBuf> = OnceLock::new();

fn perf_enabled() -> bool {
    preview_perf_enabled()
}

fn perf_log(msg: &str) {
    if !perf_enabled() {
        return;
    }
    write_perf_log(msg);
}

fn write_perf_log(msg: &str) {
    if let Some(path) = PERF_LOG_PATH.get() {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            use std::io::Write;
            let epoch_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(&mut file, "[{}] {}", epoch_ms, msg);
        }
    }
}

fn shadow_perf_log(msg: &str) {
    // COLOR/PERF (audit 2026-08-10 §L7A; hardening 2026-09-05 §LOG.01):
    // cờ shadow chỉ có hiệu lực trong binary dev, dùng chung một file log và
    // tuyệt đối không ghi path/nội dung PDF.
    if pdf_engine::render_worker::viewer_shadow_render_enabled() {
        write_perf_log(msg);
    }
}

// Cho FE đẩy dòng đo (TilePerf / ViewerPreview) vào CÙNG file PrynX_RenderPerf.log
// → user chỉ cần gửi 1 file thay vì mở devtools copy console. Chỉ ghi khi
// perf_enabled() (binary dev + PRYNX_PERF=1). Gắn prefix "FE " để phân biệt
// dòng Rust (render/encode thuần) với dòng FE (tổng thời gian chờ invoke).
#[tauri::command]
fn append_render_perf(msg: String) {
    perf_log(&format!("FE {}", msg));
}

fn numeric_version_quad(raw: &str) -> Option<[u64; 4]> {
    let parts = raw
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.len() != 4 {
        return None;
    }
    Some([parts[0], parts[1], parts[2], parts[3]])
}

fn sidecar_cache_version(name: &str) -> Option<[u64; 8]> {
    let raw = name.strip_prefix("sidecar-")?;
    let (product_raw, file_raw) = raw.split_once('-').unwrap_or((raw, raw));
    let product = numeric_version_quad(product_raw)?;
    let file = numeric_version_quad(file_raw)?;
    Some([
        product[0], product[1], product[2], product[3], file[0], file[1], file[2], file[3],
    ])
}

fn nuitka_temp_extraction_pid(name: &str) -> Option<u32> {
    let raw = name.strip_prefix("sidecar-")?;
    let (pid_raw, remainder) = raw.split_once('-')?;
    let (time_raw, random_raw) = remainder.split_once('-')?;
    if pid_raw.is_empty()
        || pid_raw.len() > 10
        || pid_raw.starts_with('0')
        || !pid_raw.bytes().all(|byte| byte.is_ascii_digit())
        || time_raw.len() != 6
        || !time_raw.bytes().all(|byte| byte.is_ascii_digit())
        || random_raw.len() != 11
        || !random_raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    pid_raw.parse::<u32>().ok().filter(|pid| *pid != 0)
}

fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn path_has_reparse_component(path: &std::path::Path) -> Result<bool, String> {
    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata_is_reparse_point(&metadata) => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Không kiểm tra được reparse point tại {}: {error}",
                    current.display()
                ))
            }
        }
    }
    Ok(false)
}

fn tree_has_reparse_point(root: &std::path::Path) -> Result<bool, String> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("Không đọc được {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| format!("Không đọc được entry: {error}"))?;
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|error| format!("Không đọc được metadata: {error}"))?;
            if metadata_is_reparse_point(&metadata) {
                return Ok(true);
            }
            if metadata.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    Ok(false)
}

fn remove_sidecar_cache_with_retry(path: &std::path::Path) -> std::io::Result<()> {
    let mut last_error = None;
    for attempt in 0..3_u64 {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1)));
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("Không xóa được cache sidecar")))
}

fn prune_sidecar_caches(
    base_dir: &std::path::Path,
    current_name: Option<&str>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let base_metadata = match std::fs::symlink_metadata(base_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Vec::new()))
        }
        Err(error) => return Err(format!("Không đọc được thư mục cache: {error}")),
    };
    if !base_metadata.is_dir()
        || metadata_is_reparse_point(&base_metadata)
        || path_has_reparse_component(base_dir)?
    {
        return Err("Bỏ qua thư mục cache không an toàn hoặc là reparse point".to_string());
    }
    let canonical_base = std::fs::canonicalize(base_dir)
        .map_err(|error| format!("Không chuẩn hóa được thư mục cache: {error}"))?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&canonical_base)
        .map_err(|error| format!("Không đọc được thư mục cache: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(version) = sidecar_cache_version(&name) else {
            continue;
        };
        let metadata = match std::fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
            continue;
        }
        let canonical_path = match std::fs::canonicalize(entry.path()) {
            Ok(path) => path,
            Err(_) => continue,
        };
        // PERF (audit 2026-08-05 §PERF.4): chỉ nhận con trực tiếp của
        // %LOCALAPPDATA%\PrynX; junction/reparse trỏ ra ngoài bị bỏ qua.
        if canonical_path.parent() != Some(canonical_base.as_path()) {
            continue;
        }
        entries.push((version, name, canonical_path));
    }
    entries.sort_by(|left, right| right.0.cmp(&left.0));

    let mut keep = std::collections::HashSet::new();
    if let Some(current) = current_name {
        if entries.iter().any(|entry| entry.1 == current) {
            keep.insert(current.to_string());
        }
    }
    if current_name.is_some() {
        for (_, name, _) in &entries {
            if keep.len() >= 2 {
                break;
            }
            keep.insert(name.clone());
        }
    }

    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for (_, name, path) in entries {
        if keep.contains(&name) {
            continue;
        }
        match tree_has_reparse_point(&path) {
            Ok(false) => {}
            Ok(true) => {
                failed.push(format!("{name}: chứa reparse point; không xóa"));
                continue;
            }
            Err(error) => {
                failed.push(format!("{name}: {error}"));
                continue;
            }
        }
        match remove_sidecar_cache_with_retry(&path) {
            Ok(()) => removed.push(name),
            Err(error) => failed.push(format!("{name}: {error}")),
        }
    }
    Ok((removed, failed))
}

fn prune_stale_nuitka_extractions<F>(
    base_dir: &std::path::Path,
    current_pid: u32,
    active_pid: F,
) -> Result<(Vec<String>, Vec<String>), String>
where
    F: Fn() -> u32,
{
    let metadata = match std::fs::symlink_metadata(base_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Vec::new()))
        }
        Err(error) => return Err(format!("Không đọc được thư mục extraction: {error}")),
    };
    if !metadata.is_dir()
        || metadata_is_reparse_point(&metadata)
        || path_has_reparse_component(base_dir)?
    {
        return Err("Bỏ qua thư mục extraction không an toàn hoặc là reparse point".to_string());
    }
    let canonical_base = std::fs::canonicalize(base_dir)
        .map_err(|error| format!("Không chuẩn hóa được thư mục extraction: {error}"))?;
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for entry in std::fs::read_dir(&canonical_base)
        .map_err(|error| format!("Không đọc được thư mục extraction: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                failed.push(format!("entry: {error}"));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(pid) = nuitka_temp_extraction_pid(&name) else {
            continue;
        };
        let live_pid = active_pid();
        if live_pid == 0 || pid == current_pid || pid == live_pid {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) => {
                failed.push(format!("{name}: {error}"));
                continue;
            }
        };
        if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
            continue;
        }
        let canonical_path = match std::fs::canonicalize(entry.path()) {
            Ok(path) if path.parent() == Some(canonical_base.as_path()) => path,
            _ => continue,
        };
        match tree_has_reparse_point(&canonical_path) {
            Ok(false) => {}
            Ok(true) => {
                failed.push(format!("{name}: chứa reparse point; không xóa"));
                continue;
            }
            Err(error) => {
                failed.push(format!("{name}: {error}"));
                continue;
            }
        }
        let live_pid = active_pid();
        if live_pid == 0 || pid == current_pid || pid == live_pid {
            continue;
        }
        match remove_sidecar_cache_with_retry(&canonical_path) {
            Ok(()) => removed.push(name),
            Err(error) => failed.push(format!("{name}: {error}")),
        }
    }
    Ok((removed, failed))
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn start_sidecar_cache_cleanup(current_pid: u32) {
    let persistent_base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("PrynX"));
    let temporary_base = std::env::temp_dir().join("PrynX");
    std::thread::spawn(move || {
        if let Some(base) = persistent_base {
            match prune_sidecar_caches(&base, None) {
                Ok((removed, failed)) => {
                    if !removed.is_empty() {
                        log::info!(
                            "[SIDECAR-CACHE] Đã xóa cache persistent cũ: {}",
                            removed.join(", ")
                        );
                    }
                    for error in failed {
                        log::warn!("[SIDECAR-CACHE] Bỏ qua cache persistent: {error}");
                    }
                }
                Err(error) => {
                    log::warn!("[SIDECAR-CACHE] Không thể prune cache persistent: {error}")
                }
            }
        }
        match prune_stale_nuitka_extractions(&temporary_base, current_pid, || {
            current_sidecar_identity().map_or(0, |identity| identity.pid)
        }) {
            Ok((removed, failed)) => {
                if !removed.is_empty() {
                    log::info!(
                        "[SIDECAR-CACHE] Đã xóa extraction tạm cũ: {}",
                        removed.join(", ")
                    );
                }
                for error in failed {
                    log::warn!("[SIDECAR-CACHE] Bỏ qua extraction tạm: {error}");
                }
            }
            Err(error) => log::warn!("[SIDECAR-CACHE] Không thể prune extraction tạm: {error}"),
        }
    });
}

fn compact_log_field(value: String, max_chars: usize) -> String {
    value
        .chars()
        .take(max_chars)
        .map(|ch| if ch == '\r' || ch == '\n' { ' ' } else { ch })
        .collect()
}

#[tauri::command]
fn log_frontend_error(
    area: String,
    error_id: String,
    app_version: String,
    message: String,
    component_stack: Option<String>,
) {
    if cfg!(debug_assertions) {
        log::error!(
            "[FRONTEND_UI] area={} error_id={} version={} message={} component_stack={}",
            compact_log_field(area, 80),
            compact_log_field(error_id, 80),
            compact_log_field(app_version, 40),
            compact_log_field(message, 800),
            compact_log_field(component_stack.unwrap_or_default(), 5000),
        );
    } else {
        // Native là authority cuối: renderer bị sửa cũng không thể nhét stack,
        // path hoặc payload vào PrynX.log production.
        log::error!(
            "[FRONTEND_UI] area={} error_id={} version={}",
            compact_log_field(area, 80),
            compact_log_field(error_id, 80),
            compact_log_field(app_version, 40),
        );
    }
}

#[derive(Default)]
struct ViewerDocumentLeases {
    owners_by_path: HashMap<String, HashSet<String>>,
}

impl ViewerDocumentLeases {
    fn claim(&mut self, file_path: &str, owner_id: &str) -> bool {
        self.owners_by_path
            .entry(file_path.to_string())
            .or_default()
            .insert(owner_id.to_string())
    }

    fn release_and_should_close(&mut self, file_path: &str, owner_id: &str) -> bool {
        let Some(owners) = self.owners_by_path.get_mut(file_path) else {
            return true;
        };
        owners.remove(owner_id);
        if !owners.is_empty() {
            return false;
        }
        self.owners_by_path.remove(file_path);
        true
    }
}

static VIEWER_DOCUMENT_LEASES: OnceLock<Mutex<ViewerDocumentLeases>> = OnceLock::new();

fn viewer_document_leases() -> &'static Mutex<ViewerDocumentLeases> {
    VIEWER_DOCUMENT_LEASES.get_or_init(|| Mutex::new(ViewerDocumentLeases::default()))
}

fn validate_viewer_lease_owner(owner_id: Option<String>) -> Result<Option<String>, String> {
    match owner_id {
        Some(owner) if owner.is_empty() || owner.len() > 256 => {
            Err("Viewer owner_id không hợp lệ.".to_string())
        }
        value => Ok(value),
    }
}

fn claim_viewer_document_lease(file_path: &str, owner_id: &str) -> bool {
    lock_mutex(viewer_document_leases()).claim(file_path, owner_id)
}

fn release_viewer_document_lease(file_path: &str, owner_id: &str) -> bool {
    lock_mutex(viewer_document_leases()).release_and_should_close(file_path, owner_id)
}

#[tauri::command]
async fn close_pdf_document(file_path: String, owner_id: Option<String>) -> Result<bool, String> {
    let owner_id = validate_viewer_lease_owner(owner_id)?;
    if owner_id
        .as_deref()
        .is_some_and(|owner| !release_viewer_document_lease(&file_path, owner))
    {
        // PERF (audit 2026-08-08 §RENDER.2): tab khác vẫn dùng cùng PDF; giữ cache ở
        // parent và mọi worker để không hủy nhầm hoặc bắt tab còn lại nạp lại tài liệu.
        perf_log("DOC_CACHE_CLOSE deferred=shared-lease");
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        match pdf_engine::render_worker::close_document_with_policy(&file_path)? {
            pdf_engine::render_worker::WorkerAttempt::Completed(closed) => Ok(closed),
            pdf_engine::render_worker::WorkerAttempt::Disabled => {
                close_pdf_document_in_process(&file_path)
            }
            pdf_engine::render_worker::WorkerAttempt::FallbackBeforeStart(reason) => {
                log::warn!("[RENDER_WORKER] close fallback trước request: {}", reason);
                close_pdf_document_in_process(&file_path)
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err("Task panicked".into()))
}

pub(crate) fn close_pdf_document_in_process(file_path: &str) -> Result<bool, String> {
    if is_sensitive_path(&file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let Some(cache_lock) = DOC_CACHE.get() else {
        return Ok(false);
    };
    let removed = {
        let mut cache = lock_mutex(cache_lock);
        cache.remove(file_path)
    };
    let existed = removed.is_some();
    // Drop Arc/document bên ngoài cache mutex; nếu render đang giữ Arc thì document
    // chỉ đóng sau khi render kết thúc, không invalid handle giữa chừng.
    drop(removed);
    perf_log(if existed {
        "DOC_CACHE_CLOSE removed=1"
    } else {
        "DOC_CACHE_CLOSE removed=0"
    });
    Ok(existed)
}

#[tauri::command]
async fn get_pdf_viewer_bootstrap(
    file_path: String,
    owner_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let owner_id = validate_viewer_lease_owner(owner_id)?;
    let claimed = owner_id
        .as_deref()
        .is_some_and(|owner| claim_viewer_document_lease(&file_path, owner));
    let rollback_path = file_path.clone();
    let rollback_owner = owner_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        match pdf_engine::render_worker::bootstrap_with_policy(&file_path)? {
            pdf_engine::render_worker::WorkerAttempt::Completed(value) => Ok(value),
            pdf_engine::render_worker::WorkerAttempt::Disabled => {
                viewer_bootstrap_in_process(&file_path)
            }
            pdf_engine::render_worker::WorkerAttempt::FallbackBeforeStart(reason) => {
                log::warn!(
                    "[RENDER_WORKER] bootstrap fallback trước request: {}",
                    reason
                );
                viewer_bootstrap_in_process(&file_path)
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err("Task panicked".into()));
    if result.is_err() && claimed {
        if let Some(owner) = rollback_owner.as_deref() {
            let _ = release_viewer_document_lease(&rollback_path, owner);
        }
    }
    result
}

#[cfg(test)]
mod viewer_document_lease_tests {
    use super::ViewerDocumentLeases;

    #[test]
    fn chi_dong_cache_sau_khi_owner_cuoi_cung_roi_pdf() {
        let mut leases = ViewerDocumentLeases::default();
        let path = "D:\\jobs\\shared.pdf";

        assert!(leases.claim(path, "viewer:a"));
        assert!(!leases.claim(path, "viewer:a"));
        assert!(leases.claim(path, "viewer:b"));
        assert!(!leases.release_and_should_close(path, "viewer:a"));
        assert!(!leases.release_and_should_close(path, "viewer:khong-ton-tai"));
        assert!(leases.release_and_should_close(path, "viewer:b"));
        assert!(leases.release_and_should_close(path, "viewer:b"));
    }
}

pub(crate) fn viewer_bootstrap_in_process(file_path: &str) -> Result<serde_json::Value, String> {
    if is_sensitive_path(file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let pdfium = ensure_pdfium()?;
    // PERF (audit 2026-08-10 §PPE.REAUDIT.1): bootstrap chỉ quét risk thật trang 1;
    // trang chưa quét fail-closed nên vẫn không phát PDFium sai màu. Pha metadata nền
    // thay summary bảo thủ bằng kết quả toàn tài liệu sau first-frame.
    let file_identity = pdf_file_identity(file_path)?;
    let document_arc =
        get_or_load_cached_document_with_identity(pdfium, file_path, file_identity, false)?;
    let color_risk = document_arc.bootstrap_color_risk.clone();
    let handle = document_arc.pool[0].get().ok_or("PDF pool empty")?;
    let _guard = lock_mutex(&handle.lock);
    let _pdfium_guard = lock_mutex(&RENDER_LOCK);
    let document = &handle.doc;
    let num_pages = document.pages().len();
    let mut width_pt = 595.0;
    let mut height_pt = 842.0;
    if num_pages > 0 {
        if let Ok(size) = document.pages().page_size(0) {
            let user_unit = document_arc.user_unit(0)?;
            width_pt = physical_page_dimension(size.width().value, user_unit, 595.0);
            height_pt = physical_page_dimension(size.height().value, user_unit, 842.0);
        }
    }
    Ok(serde_json::json!({
        "numPages": num_pages,
        "widthPt": width_pt,
        "heightPt": height_pt,
        "colorRisk": color_risk,
        "fileIdentity": pdf_file_identity_token(document_arc.file_identity),
        "renderEngine": current_pdfium_runtime_identity(),
        "viewerEngineMode": pdf_engine::render_worker::viewer_engine_mode().as_str(),
        "viewerShadowEnabled": pdf_engine::render_worker::viewer_shadow_render_enabled(),
    }))
}

#[tauri::command]
async fn get_pdf_metadata(
    file_path: String,
    expected_identity: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worker_identity = match expected_identity.as_deref() {
            Some(identity) => identity.to_string(),
            None => pdf_file_identity_token(pdf_file_identity(&file_path)?),
        };
        match pdf_engine::render_worker::metadata_with_policy(&file_path, &worker_identity)? {
            pdf_engine::render_worker::WorkerAttempt::Completed(value) => Ok(value),
            pdf_engine::render_worker::WorkerAttempt::Disabled => {
                pdf_metadata_in_process(&file_path, expected_identity.as_deref())
            }
            pdf_engine::render_worker::WorkerAttempt::FallbackBeforeStart(reason) => {
                log::warn!(
                    "[RENDER_WORKER] metadata fallback trước request: {}",
                    reason
                );
                pdf_metadata_in_process(&file_path, expected_identity.as_deref())
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err("Task panicked".into()))
}

pub(crate) fn pdf_metadata_in_process(
    file_path: &str,
    expected_identity: Option<&str>,
) -> Result<serde_json::Value, String> {
    if is_sensitive_path(file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let pdfium = ensure_pdfium()?;
    let file_identity = pdf_file_identity(file_path)?;
    if expected_identity.is_some_and(|expected| expected != pdf_file_identity_token(file_identity))
    {
        return Err(
            "File PDF đã thay đổi giữa pha hiển thị nhanh và pha metadata nền.".to_string(),
        );
    }
    let (document_arc, color_risk) =
        get_or_load_cached_document_with_color_risk(pdfium, file_path, file_identity)?;

    let handle = document_arc.pool[0].get().ok_or("PDF pool empty")?;
    let _guard = lock_mutex(&handle.lock);
    let _pdfium_guard = lock_mutex(&RENDER_LOCK);
    let document = &handle.doc;
    let num_pages = document.pages().len();

    let mut width_pt = 595.0; // Default A4
    let mut height_pt = 842.0;
    let mut all_dims = serde_json::Map::new();

    if num_pages > 0 {
        let pages = document.pages();

        // PERF (audit 2026-08-02 §LOAD.3): FPDF_GetPageSizeByIndex không load page
        // và đã trả kích thước sau intrinsic rotation (đã có regression test ở print.rs).
        if let Ok(size) = pages.page_size(0) {
            let user_unit = document_arc.user_unit(0)?;
            width_pt = physical_page_dimension(size.width().value, user_unit, 595.0);
            height_pt = physical_page_dimension(size.height().value, user_unit, 842.0);
        }

        // PAGEBOX (audit 2026-08-04 §W1.PB6): page_size() không load trang nên
        // đọc đủ cả tài liệu; không cho trang >2.000 mượn sai kích thước trang 1.
        let dimensions = collect_physical_page_dimensions(
            num_pages,
            &document_arc.user_units,
            width_pt,
            height_pt,
            |page_index| {
                pages
                    .page_size(page_index)
                    .ok()
                    .map(|size| (size.width().value, size.height().value))
            },
        )?;
        for (i, (page_width, page_height)) in dimensions.into_iter().enumerate() {
            all_dims.insert(
                (i + 1).to_string(),
                serde_json::json!({
                    "widthPt": page_width,
                    "heightPt": page_height
                }),
            );
        }
    }

    Ok(serde_json::json!({
        "numPages": num_pages,
        "widthPt": width_pt,
        "heightPt": height_pt,
        "allDims": all_dims,
        "colorRisk": color_risk,
        "fileIdentity": pdf_file_identity_token(document_arc.file_identity),
        "renderEngine": current_pdfium_runtime_identity(),
        "viewerEngineMode": pdf_engine::render_worker::viewer_engine_mode().as_str(),
        "viewerShadowEnabled": pdf_engine::render_worker::viewer_shadow_render_enabled(),
    }))
}

// ═══ Shared tile rendering core (used by both IPC command and protocol handler) ═══
fn encode_viewer_png(rgba_image: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
    encoder
        .write_image(
            rgba_image.as_raw(),
            rgba_image.width(),
            rgba_image.height(),
            image::ColorType::Rgba8.into(),
        )
        .map_err(|error| format!("Không thể mã hóa ảnh PNG của Viewer: {error:?}"))?;
    Ok(buffer)
}

pub(crate) fn render_tile_png_in_process(
    file_path: &str,
    page: i32,
    zoom: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
) -> Result<Vec<u8>, String> {
    // Guard: render là ĐỌC file tùy path do renderer truyền (IPC render_pdf_page + protocol
    // tile://). Nếu không chặn, renderer bị chèn mã có thể render → lấy nội dung file nhạy
    // cảm (khoá/credential) ra ảnh. Luồng thật chỉ render PDF trong thư mục người dùng.
    if is_sensitive_path(file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let _total_t0 = std::time::Instant::now();
    let file_identity = pdf_file_identity(file_path)?;
    // TILE_RENDER_CACHE_VERSION: đổi token khi thay cách render/encode. Identity
    // size + mtime (+ creation time nếu hệ thống có) chặn tile cũ khi file cùng path bị thay.
    // zoom LÀM TRÒN 3 chữ số trong cache_key: prefetch (FE tính computeRenderZoomPure)
    // và view chính đôi khi lệch nhau ở chữ số thập phân rất nhỏ của f32 (cùng in
    // "1.000" nhưng bit khác) → key string khác → KHÔNG trúng cache của nhau → cùng 1
    // trang render 2 lần (đo thật 2026-07-22). Gộp key theo 3 chữ số: 2 zoom chênh
    // <0.001 cho bitmap gần như giống hệt nên chia sẻ tile là an toàn → prefetch xong
    // thì view chính là CACHE HIT thật.
    let cache_key = tile_render_cache_key(
        file_path,
        file_identity,
        page,
        zoom,
        rotation,
        clip_x,
        clip_y,
        clip_w,
        clip_h,
    );

    let kind = if clip_w.is_some() && clip_h.is_some() {
        "tile"
    } else {
        "page"
    };
    {
        let cache_lock = tile_cache();
        if let Ok(mut cache) = cache_lock.lock() {
            if let Some(data) = cache.get(&cache_key) {
                let total_ms = _total_t0.elapsed().as_millis();
                perf_log(&format!(
                    "CACHE_HIT tier=ram kind={} page={} zoom={:.3} total_ms={} bytes={}",
                    kind,
                    page,
                    zoom,
                    total_ms,
                    data.len()
                ));
                return Ok(data);
            }
        }
    }

    // Cache ĐĨA: nếu tile đã từng render (mở lại/cuộn lại/zoom cũ) → đọc thẳng, khỏi render.
    {
        let dpath = tile_disk_path(&cache_key);
        let _disk_t0 = std::time::Instant::now();
        if let Some(bytes) = tile_disk_cache::read_valid_tile_png(&dpath) {
            let disk_read_ms = _disk_t0.elapsed().as_millis();
            let total_ms = _total_t0.elapsed().as_millis();
            perf_log(&format!(
                "CACHE_HIT tier=disk kind={} page={} zoom={:.3} disk_read_ms={} total_ms={} bytes={}",
                kind, page, zoom, disk_read_ms, total_ms, bytes.len()
            ));
            let cache_lock = tile_cache();
            if let Ok(mut cache) = cache_lock.lock() {
                cache.insert(cache_key.clone(), bytes.clone());
            }
            return Ok(bytes);
        }
    }

    let pdfium = ensure_pdfium()?;
    let document_arc =
        get_or_load_cached_document_with_identity(pdfium, file_path, file_identity, false)?;

    let pool_size = document_arc.pool.len();
    let pool_idx = document_arc.next.fetch_add(1, Ordering::Relaxed) % pool_size;

    // LAZY INITIALIZATION of the DocHandle. KHÔNG dùng get_or_init + .expect():
    // .expect() panic trong spawn_blocking → "Task panicked" che lỗi thật (file PDF
    // bị xoá/khoá/hỏng giữa phiên). Khởi tạo thủ công + propagate lỗi sạch (§15.7).
    let cell = &document_arc.pool[pool_idx];
    if cell.get().is_none() {
        let bytes = read_pdf_bytes_for_identity(file_path, document_arc.file_identity)?;
        let doc = load_pdf_document_from_bytes(pdfium, bytes)?;
        let page_count = {
            let _pdfium_guard = lock_mutex(&RENDER_LOCK);
            doc.pages().len() as usize
        };
        if page_count != document_arc.user_units.len() {
            drop_pdf_document_safely(doc);
            return Err(
                "Số trang PDF đã thay đổi trong lúc khởi tạo bộ hiển thị; vui lòng mở lại file."
                    .to_string(),
            );
        }
        let candidate = DocHandle {
            pages: Mutex::new(PageLru::new(document_arc.page_lru_cap)),
            lock: Mutex::new(()),
            doc,
        };
        // Race-safe: doc thừa phải đóng dưới khóa PDFium, không drop trần cạnh render khác.
        if let Err(unused) = cell.set(candidate) {
            let _load_guard = lock_mutex(&LOAD_LOCK);
            let _render_guard = lock_mutex(&RENDER_LOCK);
            drop(unused);
        }
    }
    let handle = cell
        .get()
        .ok_or_else(|| "DocHandle init failed".to_string())?;

    // Đo thật (perf_log): trả ảnh và timing cùng lúc để log sau khi nhả khóa,
    // không kéo dài vùng khóa chỉ vì instrumentation.
    let (rgba_image, lock_wait_ms, render_ms, bitmap_wh) = {
        let _guard = lock_mutex(&handle.lock);
        let page_index = (page - 1) as u16;
        if page_index >= handle.doc.pages().len() {
            return Err("Page out of bounds".into());
        }
        // Lấy page từ cache LRU. Giữ PdfPage MỞ giữa các lần render để pdfium TÁI DÙNG
        // ảnh đã giải nén (giun.pdf: 16MB ảnh/trang). Nếu mở page mới mỗi lần render,
        // pdfium giải nén lại toàn bộ → ~600-1300ms; tái dùng page → ~120ms.
        let mut lru = lock_mutex(&handle.pages);
        if !lru.map.contains_key(&page_index) {
            // SAFETY: page mượn từ handle.doc; doc nằm trong Pdfium đã Box::leak ('static),
            // sống suốt vòng đời tiến trình, nên kéo dài borrow lên 'static là hợp lệ ở đây.
            let doc_ref: &'static PdfDocument<'static> = unsafe {
                std::mem::transmute::<&PdfDocument<'static>, &'static PdfDocument<'static>>(
                    &handle.doc,
                )
            };
            let new_page = doc_ref
                .pages()
                .get(page_index)
                .map_err(|e| format!("Failed to get page: {:?}", e))?;
            if lru.order.len() >= lru.max {
                if let Some(old) = lru.order.pop_front() {
                    lru.map.remove(&old);
                }
            }
            lru.map.insert(page_index, new_page);
            lru.order.push_back(page_index);
        } else if let Some(pos) = lru.order.iter().position(|&p| p == page_index) {
            // LRU touch: chuyển page vừa dùng về cuối hàng đợi.
            lru.order.remove(pos);
            lru.order.push_back(page_index);
        }
        let pdf_page = lru
            .map
            .get(&page_index)
            .ok_or_else(|| "Page cache miss after insert".to_string())?;

        // PAGEBOX (audit 2026-08-04 §W1.PB6): clip của frontend và metadata đều ở
        // kích thước vật lý; nhân /UserUnit để bitmap/tile khớp đúng hệ tọa độ đó.
        let mut render_scale = viewer_render_scale(zoom, document_arc.user_unit(page_index)?);
        // CHỈ chặn cận DƯỚI. KHÔNG clamp cận trên: clip_x/y do frontend tính ở scale
        // THẬT (zoom×dpr); nếu clamp render_scale mà translate = -x/render_scale thì tile
        // trỏ SAI vùng → mất nội dung ở zoom cao (bug viewport-tiling). An toàn OOM vì:
        // nhánh clip bị set_fixed_size ≤4000px chặn bitmap; nhánh full-page tự hạ scale
        // bằng max_dim=8000 bên dưới. Nên trần scale là THỪA và chính là thứ phá tile.
        let render_config =
            if let (Some(x), Some(y), Some(w), Some(h)) = (clip_x, clip_y, clip_w, clip_h) {
                let safe_w = w.clamp(1, 4000) as i32;
                let safe_h = h.clamp(1, 4000) as i32;
                PdfRenderConfig::new()
                    .set_clear_color(PdfColor::WHITE)
                    .set_fixed_size(safe_w, safe_h)
                    .translate(
                        PdfPoints::new(-(x as f32) / render_scale),
                        PdfPoints::new(-(y as f32) / render_scale),
                    )
                    .unwrap_or_default()
                    .scale_page_by_factor(render_scale)
                    // LCD subpixel text → chữ sắc nét kiểu Acrobat (audit render 2026-07-06).
                    .use_lcd_text_rendering(true)
            } else {
                // VECTOR #6 FIX: Prevent PDFium OOM on extremely tall/wide documents.
                // set_target_width scales height proportionally. If a document is 50x taller than wide,
                // clamping width to 8000 could result in height = 400,000 (12.8GB RAM), causing STATUS_STACK_BUFFER_OVERRUN.
                let max_dim = 8000.0_f32;
                let width_pt = pdf_page.width().value;
                let height_pt = pdf_page.height().value;

                if width_pt * render_scale > max_dim {
                    render_scale = max_dim / width_pt;
                }
                if height_pt * render_scale > max_dim {
                    render_scale = max_dim / height_pt;
                }

                let safe_w = (width_pt * render_scale).max(1.0) as i32;

                PdfRenderConfig::new()
                    .set_clear_color(PdfColor::WHITE)
                    .set_target_width(safe_w)
                    // LCD subpixel text → chữ sắc nét kiểu Acrobat (audit render 2026-07-06).
                    .use_lcd_text_rendering(true)
            };
        // RENDER_LOCK: serialize với đường in (print.rs mở doc riêng ngoài DOC_CACHE).
        // PDFium không thread-safe kể cả trên doc khác nhau.
        let _lock_t0 = std::time::Instant::now();
        let _render_guard = lock_mutex(&RENDER_LOCK);
        let lock_wait_ms = _lock_t0.elapsed().as_millis();
        let _render_t0 = std::time::Instant::now();
        let bitmap = pdf_page
            .render_with_config(&render_config)
            .map_err(|e| format!("Failed to render page: {:?}", e))?;
        let img = bitmap.as_image().to_rgba8();
        let render_ms = _render_t0.elapsed().as_millis();
        let bitmap_wh = (img.width() as i32, img.height() as i32);
        (img, lock_wait_ms, render_ms, bitmap_wh)
    };

    // COLOR (audit 2026-08-07 §GV.1/§GV.4): trang chính và tile dùng PNG lossless
    // cùng một hợp đồng. Trên artifact CMYK-gradient, PNG encode 4–10 ms trong khi
    // JPEG q90 mất 133–334 ms và thêm sai số 1–2 mức/kênh. Cache RAM/đĩa đã có budget
    // theo phần cứng nên không hạ chất lượng vô điều kiện trên máy >=16GB.
    let _encode_t0 = std::time::Instant::now();
    let buffer = encode_viewer_png(&rgba_image)?;
    let encode_ms = _encode_t0.elapsed().as_millis();
    // LƯU Ý: block ghi PrynX_Performance.log kiểu cũ dùng chrono::Local::now() và PANIC
    // ở release. perf_log() thay bằng SystemTime epoch (không chrono) + chỉ ghi khi
    // perf_enabled() → an toàn. Ghi SAU khi encode xong, NGOÀI mọi vùng khóa.
    let _cache_t0 = std::time::Instant::now();

    // PERF (audit 2026-08-05 §PERF.7): kiểm dung lượng trống trước khi ghi cache;
    // ổ gần đầy chỉ bỏ cache đĩa, ảnh vẫn trả về và vẫn được cache RAM bình thường.
    // I/O đĩa nằm ngoài mutex RAM để cache hit từ thread khác không phải chờ ghi file.
    let dpath = tile_disk_path(&cache_key);
    let disk_decision = tile_disk_cache::tile_disk_write_decision(&dpath, buffer.len());
    if disk_decision.write {
        let _ = tile_disk_cache::write_tile_png_atomic(&dpath, &buffer);
    }
    // Quét nền ngay lần ghi đầu; tier ít dung lượng quét thường hơn, tier rộng giữ
    // nhịp 64 lần cũ. AtomicBool trong module chặn nhiều thread prune trùng nhau.
    let disk_attempt = DISK_CACHE_WRITES.fetch_add(1, Ordering::Relaxed);
    if disk_attempt % disk_decision.prune_interval == 0 {
        tile_disk_cache::schedule_tile_disk_prune(tile_cache_dir());
    }

    {
        let cache_lock = tile_cache();
        if let Ok(mut cache) = cache_lock.lock() {
            cache.insert(cache_key, buffer.clone());
        }
    }

    let cache_ms = _cache_t0.elapsed().as_millis();
    let total_ms = _total_t0.elapsed().as_millis();
    // Tag "tile" (clip) vs "page" (full-page) để tách chi phí 2 loại render.
    perf_log(&format!(
        "RENDER kind={} page={} zoom={:.3} wh={}x{} lock_wait_ms={} render_ms={} encode_ms={} cache_ms={} total_ms={} bytes={}",
        kind, page, zoom, bitmap_wh.0, bitmap_wh.1,
        lock_wait_ms, render_ms, encode_ms, cache_ms, total_ms, buffer.len()
    ));

    Ok(buffer)
}

// PERF (audit 2026-08-08 §RENDER.2): một semaphore dùng chung cho IPC và tile://.
// Worker mode lấy số slot theo tier RAM/CPU; máy <8 GiB vẫn giữ hai cửa vào để request
// interactive tới được manager và preempt background. Mode off giữ trần 4 cũ.
static RENDER_SEMAPHORE: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::OnceLock::new();
static RENDER_BACKGROUND_SEMAPHORE: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::OnceLock::new();
static TILE_PROTOCOL_REQUEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

fn render_request_semaphore() -> std::sync::Arc<tokio::sync::Semaphore> {
    RENDER_SEMAPHORE
        .get_or_init(|| {
            std::sync::Arc::new(tokio::sync::Semaphore::new(
                pdf_engine::render_worker::configured_render_request_slots(),
            ))
        })
        .clone()
}

fn background_render_request_slots(total_slots: usize) -> usize {
    total_slots.saturating_sub(1).max(1)
}

fn background_render_semaphore() -> std::sync::Arc<tokio::sync::Semaphore> {
    RENDER_BACKGROUND_SEMAPHORE
        .get_or_init(|| {
            let total_slots = pdf_engine::render_worker::configured_render_request_slots();
            std::sync::Arc::new(tokio::sync::Semaphore::new(
                background_render_request_slots(total_slots),
            ))
        })
        .clone()
}

struct RenderRequestPermits {
    _background: Option<tokio::sync::OwnedSemaphorePermit>,
    _total: tokio::sync::OwnedSemaphorePermit,
}

async fn acquire_render_request_permits(
    purpose: pdf_engine::render_worker::RenderPurpose,
) -> Result<RenderRequestPermits, String> {
    // PERF (audit 2026-08-08 §RENDER.2): request nền lấy quota nền trước nên không thể
    // giữ chỗ trong semaphore tổng khi đang chờ lane. Luôn còn ít nhất một cửa cho trang
    // người dùng đang xem đi tới worker manager và preempt việc nền trên máy ít RAM.
    let background = if purpose == pdf_engine::render_worker::RenderPurpose::Interactive {
        None
    } else {
        Some(
            background_render_semaphore()
                .acquire_owned()
                .await
                .map_err(|_| "Render background semaphore closed".to_string())?,
        )
    };
    let total = render_request_semaphore()
        .acquire_owned()
        .await
        .map_err(|_| "Render semaphore closed".to_string())?;
    Ok(RenderRequestPermits {
        _background: background,
        _total: total,
    })
}

#[derive(Clone, Debug, PartialEq)]
struct TileProtocolRenderRequest {
    file_path: String,
    page: i32,
    zoom: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    purpose: pdf_engine::render_worker::RenderPurpose,
}

fn parse_tile_protocol_purpose(
    query: Option<&str>,
) -> Result<pdf_engine::render_worker::RenderPurpose, String> {
    let mut purpose = None;
    for pair in query
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty())
    {
        let (key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != "purpose" {
            continue;
        }
        if purpose.is_some() {
            return Err("Tham số purpose của tile bị lặp.".to_string());
        }
        let value = urlencoding::decode(raw_value)
            .map_err(|_| "Tham số purpose của tile không hợp lệ.".to_string())?;
        purpose = Some(match value.as_ref() {
            "interactive" => pdf_engine::render_worker::RenderPurpose::Interactive,
            "background" => pdf_engine::render_worker::RenderPurpose::Background,
            _ => return Err("Tham số purpose của tile không được hỗ trợ.".to_string()),
        });
    }
    Ok(purpose.unwrap_or(pdf_engine::render_worker::RenderPurpose::Interactive))
}

fn parse_tile_protocol_request(url: &str) -> Result<TileProtocolRenderRequest, String> {
    // Query phải được tách trước rsplit; nếu không `purpose=background` dính vào clip_h
    // và biến thumbnail thành render nguyên trang.
    let (url_without_query, query) = url
        .split_once('?')
        .map_or((url, None), |(path, query)| (path, Some(query)));
    let mut path = url_without_query;
    if path.starts_with("http://tile.localhost/") {
        path = &path["http://tile.localhost/".len()..];
    } else if path.starts_with("https://tile.localhost/") {
        path = &path["https://tile.localhost/".len()..];
    } else if path.starts_with("tile://localhost/") {
        path = &path["tile://localhost/".len()..];
    } else if path.starts_with("tile://") {
        path = &path["tile://".len()..];
    }

    let parts: Vec<&str> = path.rsplitn(8, '/').collect();
    if parts.len() != 8 || parts[7].is_empty() {
        return Err("Bad request".to_string());
    }
    let ch: Option<i32> = parts[0].parse().ok();
    let cw: Option<i32> = parts[1].parse().ok();
    let cy: Option<i32> = parts[2].parse().ok();
    let cx: Option<i32> = parts[3].parse().ok();
    let rotation: i32 = parts[4].parse().unwrap_or(0);
    let zoom: f32 = parts[5].parse().unwrap_or(1.0);
    let page: i32 = parts[6].parse().unwrap_or(1);
    let file_path_encoded = parts[7];
    let file_path = urlencoding::decode(file_path_encoded)
        .unwrap_or_else(|_| file_path_encoded.into())
        .to_string();

    Ok(TileProtocolRenderRequest {
        file_path,
        page,
        zoom,
        rotation,
        clip_x: cx.filter(|&value| value != 0 || cw.unwrap_or(0) != 0),
        clip_y: cy.filter(|&value| value != 0 || ch.unwrap_or(0) != 0),
        clip_w: cw.filter(|&value| value != 0),
        clip_h: ch.filter(|&value| value != 0),
        purpose: parse_tile_protocol_purpose(query)?,
    })
}

fn tile_protocol_render_context(
    request: &TileProtocolRenderRequest,
) -> pdf_engine::render_worker::ViewerRenderContext {
    let sequence = TILE_PROTOCOL_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let kind = if request.clip_w.is_some() && request.clip_h.is_some() {
        "viewport"
    } else {
        "page"
    };
    pdf_engine::render_worker::ViewerRenderContext {
        request_id: format!("tile:{}:{sequence}", std::process::id()),
        owner_id: "tauri:tile-protocol".to_string(),
        group_key: format!("page:{}:{kind}", request.page),
        generation: 0,
        purpose: request.purpose,
        priority: if request.purpose == pdf_engine::render_worker::RenderPurpose::Interactive {
            0
        } else {
            500
        },
        pipeline_identity: pdf_engine::render_worker::RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
    }
}

#[cfg(test)]
mod tile_protocol_request_tests {
    use super::*;

    #[test]
    fn query_background_khong_lam_hong_clip_goc_trai() {
        let request = parse_tile_protocol_request(
            "http://tile.localhost/D%3A%5Cjobs%5Cfile%20in.pdf/3/0.3/90/0/0/180/240?purpose=background",
        )
        .unwrap();

        assert_eq!(request.file_path, "D:\\jobs\\file in.pdf");
        assert_eq!(request.page, 3);
        assert_eq!(request.zoom, 0.3);
        assert_eq!(request.rotation, 90);
        assert_eq!((request.clip_x, request.clip_y), (Some(0), Some(0)));
        assert_eq!((request.clip_w, request.clip_h), (Some(180), Some(240)));
        assert_eq!(
            request.purpose,
            pdf_engine::render_worker::RenderPurpose::Background
        );
    }

    #[test]
    fn url_cu_mac_dinh_interactive_va_khong_clip() {
        let request =
            parse_tile_protocol_request("tile://localhost/C%3A%5Cjobs%5Clegacy.pdf/1/1/0/0/0/0/0")
                .unwrap();

        assert_eq!(request.clip_x, None);
        assert_eq!(request.clip_y, None);
        assert_eq!(request.clip_w, None);
        assert_eq!(request.clip_h, None);
        assert_eq!(
            request.purpose,
            pdf_engine::render_worker::RenderPurpose::Interactive
        );
    }

    #[test]
    fn request_thieu_truong_va_purpose_sai_bi_tu_choi() {
        assert!(parse_tile_protocol_request("tile://localhost/file.pdf/1/1/0/0/0/0").is_err());
        assert!(parse_tile_protocol_request(
            "tile://localhost/file.pdf/1/1/0/0/0/0/0?purpose=accurate",
        )
        .is_err());
    }

    #[test]
    fn quota_background_luon_chua_mot_cua_tuong_tac() {
        assert_eq!(background_render_request_slots(2), 1);
        assert_eq!(background_render_request_slots(4), 3);
        assert_eq!(background_render_request_slots(9), 8);
    }
}

#[tauri::command]
async fn render_pdf_page(
    _app_handle: tauri::AppHandle,
    file_path: String,
    page: i32,
    zoom: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    request_context: Option<pdf_engine::render_worker::ViewerRenderContext>,
) -> Result<tauri::ipc::Response, String> {
    let command_t0 = std::time::Instant::now();
    let kind = if clip_w.is_some() && clip_h.is_some() {
        "tile"
    } else {
        "page"
    };
    let sem_t0 = std::time::Instant::now();
    let request_purpose = request_context
        .as_ref()
        .map(|context| context.purpose)
        .unwrap_or(pdf_engine::render_worker::RenderPurpose::Interactive);
    // PERF (audit 2026-08-08 §RENDER.2): đăng ký request trước khi chờ quota. Nếu user
    // đổi zoom trong lúc hàng đợi đang kín, cancel_pdf_render phải đánh dấu được request
    // ngay; sau khi lấy permit nó bị loại trước khi chiếm worker/PDFium.
    let pending_worker_lease = request_context
        .as_ref()
        .map(|context| pdf_engine::render_worker::PendingWorkerLease::register(&context.request_id))
        .transpose()?;
    let _permits = acquire_render_request_permits(request_purpose).await?;
    if pending_worker_lease
        .as_ref()
        .is_some_and(|pending| pending.is_cancelled())
    {
        return Err("Render request đã bị hủy trong lúc chờ quota.".to_string());
    }
    let sem_wait_ms = sem_t0.elapsed().as_millis();
    let submitted_t0 = std::time::Instant::now();
    let (result, worker_queue_ms, core_ms) = tauri::async_runtime::spawn_blocking(move || {
        let worker_queue_ms = submitted_t0.elapsed().as_millis();
        let core_t0 = std::time::Instant::now();
        let worker_attempt = if let Some(pending) = pending_worker_lease.as_ref() {
            pdf_engine::render_worker::render_display_with_reserved_policy(
                &file_path,
                page,
                zoom,
                rotation,
                clip_x,
                clip_y,
                clip_w,
                clip_h,
                request_context.as_ref(),
                pending,
            )
        } else {
            pdf_engine::render_worker::render_display_with_policy(
                &file_path, page, zoom, rotation, clip_x, clip_y, clip_w, clip_h, None,
            )
        };
        let render_result = match worker_attempt {
            Ok(pdf_engine::render_worker::WorkerAttempt::Completed(output)) => {
                perf_log(&format!(
                    "RENDER_WORKER_RESULT page={} zoom={:.3} total_ms={} bytes={}",
                    page,
                    zoom,
                    output.response.timing.total_ms,
                    output.bytes.len()
                ));
                Ok(output.bytes)
            }
            Ok(pdf_engine::render_worker::WorkerAttempt::Disabled) => render_tile_png_in_process(
                &file_path, page, zoom, rotation, clip_x, clip_y, clip_w, clip_h,
            ),
            Ok(pdf_engine::render_worker::WorkerAttempt::FallbackBeforeStart(reason)) => {
                log::warn!("[RENDER_WORKER] fallback trước request: {}", reason);
                render_tile_png_in_process(
                    &file_path, page, zoom, rotation, clip_x, clip_y, clip_w, clip_h,
                )
            }
            Err(error) => Err(error),
        };
        let result = match render_result {
            Ok(data) => Ok(data),
            Err(e) => {
                // Ghi LÝ DO thật ra log (release tắt devtools → console.error phía JS biến
                // mất). Đây là manh mối chẩn đoán "xem trước trắng" trên máy khách: pdfium
                // OOM/clamp tờ lớn, file backend sinh hỏng, hết RAM, page out of bounds...
                log::error!(
                    "[RENDER] Fail file='{}' page={} zoom={} rot={}: {}",
                    file_path,
                    page,
                    zoom,
                    rotation,
                    e
                );
                Err(e)
            }
        };
        let core_ms = core_t0.elapsed().as_millis();
        (result, worker_queue_ms, core_ms)
    })
    .await
    .unwrap_or_else(|_| {
        // Task panic (vd STATUS_STACK_BUFFER_OVERRUN khi bitmap tờ booklet quá lớn) —
        // trước đây nuốt lý do thành "Task panicked" chung chung. Ghi lại để lần theo.
        log::error!("[RENDER] Task panicked (khả năng pdfium crash: bitmap quá lớn / OOM)");
        (Err("Task panicked".into()), 0, 0)
    });
    let command_ms = command_t0.elapsed().as_millis();
    match result {
        Ok(data) => {
            perf_log(&format!(
                "IPC_RENDER kind={} page={} zoom={:.3} sem_wait_ms={} worker_queue_ms={} core_ms={} command_ms={} bytes={}",
                kind, page, zoom, sem_wait_ms, worker_queue_ms, core_ms, command_ms, data.len()
            ));
            Ok(tauri::ipc::Response::new(data))
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
async fn render_ppe_page(
    file_path: String,
    page: i32,
    dpi: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    session_owner_id: String,
    request_context: pdf_engine::render_worker::ViewerRenderContext,
) -> Result<tauri::ipc::Response, String> {
    let command_t0 = std::time::Instant::now();
    let request_purpose = pdf_engine::render_worker::render_lane_purpose(
        request_context.purpose,
        request_context.priority,
    );
    // PERF/COLOR (audit 2026-08-09 §L3C): đăng ký trước quota để wheel/unmount
    // hủy được request PPE cả khi nó còn đang chờ lane vật lý.
    let pending_worker_lease =
        pdf_engine::render_worker::PendingWorkerLease::register(&request_context.request_id)?;
    let sem_t0 = std::time::Instant::now();
    let _permits = acquire_render_request_permits(request_purpose).await?;
    if pending_worker_lease.is_cancelled() {
        return Err("PPE request đã bị hủy trong lúc chờ quota.".to_string());
    }
    let sem_wait_ms = sem_t0.elapsed().as_millis();
    let submitted_t0 = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let worker_queue_ms = submitted_t0.elapsed().as_millis();
        let attempt = pdf_engine::render_worker::render_accurate_with_reserved_policy(
            &file_path,
            page,
            dpi,
            rotation,
            clip_x,
            clip_y,
            clip_w,
            clip_h,
            &session_owner_id,
            &request_context,
            &pending_worker_lease,
        );
        match attempt {
            Ok(pdf_engine::render_worker::AccurateWorkerAttempt::Completed(output)) => {
                perf_log(&format!(
                    "PPE_NATIVE_RESULT page={} dpi={:.1} total_ms={} sem_wait_ms={} worker_queue_ms={} bytes={}",
                    page,
                    dpi,
                    output.response.timing.total_ms,
                    sem_wait_ms,
                    worker_queue_ms,
                    output.bytes.len()
                ));
                Ok(output.bytes)
            }
            Ok(pdf_engine::render_worker::AccurateWorkerAttempt::Disabled) => Err(format!(
                "{} worker-disabled",
                pdf_engine::render_worker::PPE_NATIVE_FALLBACK_BEFORE_START_PREFIX
            )),
            Ok(pdf_engine::render_worker::AccurateWorkerAttempt::FallbackBeforeStart(reason)) => {
                Err(format!(
                    "{} {}",
                    pdf_engine::render_worker::PPE_NATIVE_FALLBACK_BEFORE_START_PREFIX,
                    reason
                ))
            }
            Ok(pdf_engine::render_worker::AccurateWorkerAttempt::Unsupported(unsupported)) => {
                // CORRECTNESS (audit 2026-08-10 §L7B): capability thiếu là trạng
                // thái riêng; frontend hybrid được lùi compatibility, còn crash/I/O
                // vẫn đi nhánh Err thường và tuyệt đối không bị che.
                let payload = serde_json::to_string(&unsupported)
                    .map_err(|error| format!("Không mã hóa được lý do PPE unsupported: {error}"))?;
                Err(format!(
                    "{}{}",
                    pdf_engine::render_worker::PPE_NATIVE_UNSUPPORTED_PREFIX,
                    payload
                ))
            }
            Err(error) => Err(error),
        }
    })
    .await
    .unwrap_or_else(|_| Err("PPE native task panicked sau khi nhận request.".to_string()));
    match result {
        Ok(data) => {
            perf_log(&format!(
                "IPC_PPE page={} dpi={:.1} command_ms={} bytes={}",
                page,
                dpi,
                command_t0.elapsed().as_millis(),
                data.len()
            ));
            Ok(tauri::ipc::Response::new(data))
        }
        Err(error) => Err(error),
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerShadowRenderReport {
    status: String,
    document_hash: String,
    artifact_hash: Option<String>,
    display_artifact_hash: Option<String>,
    rgb_mae: Option<f64>,
    page: i32,
    dpi: f32,
    total_ms: u64,
    display_total_ms: Option<u64>,
    render_ms: Option<u64>,
    encode_ms: Option<u64>,
    cache_ms: Option<u64>,
    unsupported_reason: Option<pdf_engine::render_worker::RenderUnsupportedReason>,
    fallback_font_sha256: Option<String>,
}

fn shadow_png_rgb_mae(first: &[u8], second: &[u8]) -> Option<f64> {
    let first = image::load_from_memory(first).ok()?.to_rgba8();
    let second = image::load_from_memory(second).ok()?.to_rgba8();
    if first.dimensions() != second.dimensions() || first.is_empty() {
        return None;
    }
    let mut total = 0_u64;
    for (left, right) in first.pixels().zip(second.pixels()) {
        for channel in 0..3 {
            let composite = |value: u8, alpha: u8| -> i32 {
                let alpha = u32::from(alpha);
                ((u32::from(value) * alpha + 255 * (255 - alpha) + 127) / 255) as i32
            };
            total += composite(left[channel], left[3]).abs_diff(composite(right[channel], right[3]))
                as u64;
        }
    }
    Some(total as f64 / (first.width() as f64 * first.height() as f64 * 3.0))
}

#[tauri::command]
async fn shadow_render_ppe_page(
    file_path: String,
    page: i32,
    dpi: f32,
    rotation: i32,
    session_owner_id: String,
    mut request_context: pdf_engine::render_worker::ViewerRenderContext,
) -> Result<Option<ViewerShadowRenderReport>, String> {
    if !pdf_engine::render_worker::viewer_shadow_render_enabled() {
        return Ok(None);
    }
    // PERF/COLOR (audit 2026-08-10 §L7A): shadow luôn ở lane nền và không trả
    // bitmap cho WebView. Chỉ report hash/timing/soundness đi qua IPC/log.
    request_context.purpose = pdf_engine::render_worker::RenderPurpose::Background;
    request_context.priority = request_context.priority.max(500);
    request_context.pipeline_identity =
        pdf_engine::render_worker::RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string();
    let report = tauri::async_runtime::spawn_blocking(move || {
        use sha2::Digest;

        let identity = pdf_file_identity(&file_path)
            .map_err(|_| "Không đọc được identity PDF cho shadow render.".to_string())?;
        let document_token = pdf_file_identity_token(identity);
        let document_hash = hex::encode(sha2::Sha256::digest(document_token.as_bytes()));
        let attempt = pdf_engine::render_worker::render_accurate_with_policy(
            &file_path,
            page,
            dpi,
            rotation,
            None,
            None,
            None,
            None,
            &session_owner_id,
            Some(&request_context),
        );
        let report = match attempt {
            Ok(pdf_engine::render_worker::AccurateWorkerAttempt::Completed(output)) => {
                let ppe_timing = output.response.timing;
                let fallback_font_sha256 = output.response.fallback_font_sha256.clone();
                let artifact_hash = hex::encode(sha2::Sha256::digest(&output.bytes));
                let mut display_context = request_context.clone();
                display_context.request_id = format!("{}-display", display_context.request_id);
                display_context.group_key = format!("shadow:display:page:{page}");
                display_context.pipeline_identity =
                    pdf_engine::render_worker::RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string();
                let display = pdf_engine::render_worker::render_display_with_policy(
                    &file_path,
                    page,
                    dpi / 96.0,
                    rotation,
                    None,
                    None,
                    None,
                    None,
                    Some(&display_context),
                );
                let (display_artifact_hash, rgb_mae, display_total_ms) = match display {
                    Ok(pdf_engine::render_worker::WorkerAttempt::Completed(display)) => (
                        Some(hex::encode(sha2::Sha256::digest(&display.bytes))),
                        shadow_png_rgb_mae(&output.bytes, &display.bytes),
                        Some(display.response.timing.total_ms),
                    ),
                    _ => (None, None, None),
                };
                ViewerShadowRenderReport {
                    status: if rgb_mae.is_some() {
                        "ready"
                    } else {
                        "comparison_error"
                    }
                    .to_string(),
                    document_hash,
                    artifact_hash: Some(artifact_hash),
                    display_artifact_hash,
                    rgb_mae,
                    page,
                    dpi,
                    total_ms: ppe_timing.total_ms,
                    display_total_ms,
                    render_ms: ppe_timing.render_ms,
                    encode_ms: ppe_timing.encode_ms,
                    cache_ms: ppe_timing.cache_ms,
                    unsupported_reason: None,
                    fallback_font_sha256,
                }
            }
            Ok(pdf_engine::render_worker::AccurateWorkerAttempt::Unsupported(unsupported)) => {
                ViewerShadowRenderReport {
                    status: "unsupported".to_string(),
                    document_hash,
                    artifact_hash: None,
                    display_artifact_hash: None,
                    rgb_mae: None,
                    page,
                    dpi,
                    total_ms: unsupported.timing.total_ms,
                    display_total_ms: None,
                    render_ms: unsupported.timing.render_ms,
                    encode_ms: unsupported.timing.encode_ms,
                    cache_ms: unsupported.timing.cache_ms,
                    unsupported_reason: Some(unsupported.reason),
                    fallback_font_sha256: unsupported.fallback_font_sha256,
                }
            }
            Ok(pdf_engine::render_worker::AccurateWorkerAttempt::Disabled)
            | Ok(pdf_engine::render_worker::AccurateWorkerAttempt::FallbackBeforeStart(_)) => {
                ViewerShadowRenderReport {
                    status: "unavailable".to_string(),
                    document_hash,
                    artifact_hash: None,
                    display_artifact_hash: None,
                    rgb_mae: None,
                    page,
                    dpi,
                    total_ms: 0,
                    display_total_ms: None,
                    render_ms: None,
                    encode_ms: None,
                    cache_ms: None,
                    unsupported_reason: None,
                    fallback_font_sha256: None,
                }
            }
            Err(_) => ViewerShadowRenderReport {
                status: "error".to_string(),
                document_hash,
                artifact_hash: None,
                display_artifact_hash: None,
                rgb_mae: None,
                page,
                dpi,
                total_ms: 0,
                display_total_ms: None,
                render_ms: None,
                encode_ms: None,
                cache_ms: None,
                unsupported_reason: None,
                fallback_font_sha256: None,
            },
        };
        if let Ok(serialized) = serde_json::to_string(&report) {
            shadow_perf_log(&format!("PPE_SHADOW {serialized}"));
        }
        Ok(report)
    })
    .await
    .unwrap_or_else(|_| Err("Shadow PPE task panicked.".to_string()))?;
    Ok(Some(report))
}

#[tauri::command]
async fn release_ppe_session_owner(session_owner_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match pdf_engine::render_worker::release_accurate_session_owner_with_policy(
            &session_owner_id,
        )? {
            pdf_engine::render_worker::WorkerAttempt::Completed(released) => Ok(released),
            pdf_engine::render_worker::WorkerAttempt::Disabled => Ok(false),
            pdf_engine::render_worker::WorkerAttempt::FallbackBeforeStart(_) => Ok(false),
        }
    })
    .await
    .unwrap_or_else(|_| Err("Task cleanup PPE panicked".to_string()))
}

#[tauri::command]
fn cancel_pdf_render(request_id: String) -> bool {
    // PERF (audit 2026-08-08 §RENDER.2): worker đang kẹt trong PDFium không thể đọc
    // frame cancel; parent terminate đúng process lease theo request ID đang hoạt động.
    pdf_engine::render_worker::cancel_render_request(&request_id)
}

#[tauri::command]
fn take_startup_system_file_batch(
    state: tauri::State<SystemFilesState>,
) -> Option<SystemFileBatch> {
    // FILEIO (audit 2026-08-26 §FILE.A1): argv là sự kiện one-shot; reload
    // WebView không được mở lại file mà Windows đã giao từ đầu process.
    state.take_startup()
}

#[tauri::command]
fn get_startup_args(state: tauri::State<SystemFilesState>) -> Vec<String> {
    // Tương thích frontend cũ; command mới và cũ cùng consume một inbox.
    state
        .take_startup()
        .map(|batch| batch.args)
        .unwrap_or_default()
}

#[tauri::command]
/// SECURITY (đồng bộ với fs capability deny + assetProtocol deny): từ chối đọc các vị
/// trí nhạy cảm + chặn path traversal ("..").
/// Áp cho các lệnh Rust đọc file vì capability `deny` chỉ ràng plugin-fs, KHÔNG
/// ràng lệnh Rust tự viết. Không ảnh hưởng mở PDF/ảnh (không nằm ở các thư mục này).
///
/// AUDIT 2026-07-26: danh sách này TRƯỚC ĐÂY hẹp hơn cả hai deny-list (thiếu Protect
/// = master key DPAPI, Vault, profile trình duyệt, `PrynX\*.dat`, `.docker`). Khi đó
/// lớp chặn thực tế chỉ còn allowlist ĐUÔI FILE của `read_system_file` — thêm một đuôi
/// mới là mở cửa. Nay đồng bộ đủ 3 nơi (tauri.conf.json, capabilities/default.json,
/// hàm này) để không phụ thuộc một lớp duy nhất.
///
/// SEC (audit 2026-08-28 §SEC.04): hàm này TỪNG so khớp CHUỖI THÔ do renderer gửi, nên
/// mọi biến thể cùng trỏ tới một file đều lọt qua deny-list:
///   - `\\?\C:\Users\<u>\.aws\...` (verbatim) và `\??\C:\...` (NT) — `norm` không bắt đầu
///     bằng `c:\users\<u>` nên không khớp prefix nào, mà Win32 `fs::read` vẫn mở được;
///   - `C:\Users\BOB~1\.aws\...` (tên 8.3);
///   - junction/symlink trỏ vào thư mục nhạy cảm;
///   - `\\localhost\C$\Users\<u>\.aws\...` (admin share, đi vòng ổ cục bộ).
/// Đường khai thác cụ thể: `read_system_file` cho phép đuôi `.json`, nên một renderer bị
/// chèn mã đọc được `.aws\sso\cache\*.json` (bearer token) hoặc `.docker\config.json`.
/// Cùng lỗ áp cho protocol `localfile://` (không cần `invoke`, chỉ cần một thẻ `<img>`).
///
/// Bản vá đặt ở GỐC (giữ nguyên signature) để MỌI call-site được bảo vệ, thay vì vá lẻ
/// tại 4 call-site nóng như trước:
///   1. bóc tiền tố verbatim/NT về cùng một mặt phẳng so khớp;
///   2. chặn admin share (`\\host\C$`) — share NAS hợp lệ của xưởng in dùng TÊN share
///      (`\\nas\khuon`) nên KHÔNG bị chặn, luồng mở PDF trên mạng vẫn chạy;
///   3. canonicalize khi path tồn tại rồi so LẠI — bước này mới thật sự bịt 8.3,
///      junction và symlink, vì `canonicalize` trả về dạng dài đã resolve.
fn is_sensitive_path(path: &str) -> bool {
    if is_sensitive_path_text(&strip_path_prefix_aliases(path)) {
        return true;
    }
    // Chỉ canonicalize khi cần: path không tồn tại thì không có junction/8.3 để resolve.
    // Lỗi canonicalize (không quyền, ổ rút ra) KHÔNG được coi là "an toàn" — nhưng cũng
    // không tự chặn, vì sink phía sau sẽ fail bằng lỗi I/O thật; giữ nguyên hành vi cũ
    // cho ca này để không brick luồng mở file hợp lệ trên NAS chập chờn.
    match std::fs::canonicalize(std::path::Path::new(path)) {
        Ok(resolved) => {
            let resolved_text = resolved.to_string_lossy();
            is_sensitive_path_text(&strip_path_prefix_aliases(&resolved_text))
        }
        Err(_) => false,
    }
}

/// Bóc tiền tố verbatim/NT để deny-list so khớp trên cùng một mặt phẳng.
///
/// `\\?\C:\x` → `C:\x`; `\\?\UNC\srv\share` → `\\srv\share`; `\??\C:\x` → `C:\x`.
/// Lặp nhiều lượt vì Win32 chấp nhận tiền tố lồng nhau (`\\?\\??\C:\...`), bóc một lần
/// là chưa đủ. Trả về chuỗi ĐÃ hạ hoa/thường + đổi `/` thành `\` (NTFS không phân biệt
/// hoa/thường và nhận cả hai dấu phân cách).
fn strip_path_prefix_aliases(path: &str) -> String {
    let mut norm = path.replace('/', "\\").to_lowercase();
    for _ in 0..4 {
        if let Some(rest) = norm.strip_prefix(r"\\?\unc\") {
            norm = format!(r"\\{rest}");
        } else if let Some(rest) = norm.strip_prefix(r"\??\unc\") {
            norm = format!(r"\\{rest}");
        } else if let Some(rest) = norm.strip_prefix(r"\\?\") {
            norm = rest.to_string();
        } else if let Some(rest) = norm.strip_prefix(r"\??\") {
            norm = rest.to_string();
        } else {
            break;
        }
    }
    norm
}

/// Share ẩn/quản trị (`\\host\C$`, `\\host\ADMIN$`) và device namespace (`\\.\`) là đường
/// vòng để chạm ổ cục bộ mà không khớp bất kỳ prefix `%USERPROFILE%` nào.
/// Share dữ liệu hợp lệ (`\\nas\khuon`, `\\server\in-an`) không kết thúc bằng `$`.
fn is_admin_or_device_share(norm: &str) -> bool {
    if norm.starts_with(r"\\.\") {
        return true;
    }
    let Some(rest) = norm.strip_prefix(r"\\") else {
        return false;
    };
    let mut parts = rest.split('\\').filter(|part| !part.is_empty());
    let _host = parts.next();
    matches!(parts.next(), Some(share) if share.ends_with('$'))
}

/// Phần so khớp thuần chuỗi. Nhận chuỗi ĐÃ chuẩn hoá bởi `strip_path_prefix_aliases`.
fn is_sensitive_path_text(norm: &str) -> bool {
    // Chống path traversal
    if norm.contains("\\..\\") || norm.ends_with("\\..") || norm.starts_with("..\\") {
        return true;
    }
    if is_admin_or_device_share(norm) {
        return true;
    }
    let norm = norm.to_string();

    // Khoá/bí mật theo TÊN FILE — chặn ở MỌI thư mục (đối xứng `**/.env`, `**/*.pem`,
    // `**/id_rsa*`… trong assetProtocol deny). Không đụng luồng thật: PDF/ảnh/ICC/font
    // không mang các đuôi/tên này.
    let file_name = norm.rsplit('\\').next().unwrap_or("");
    if file_name == ".env"
        || file_name.starts_with(".env.")
        || file_name == ".git-credentials"
        || file_name == ".npmrc"
        || file_name == ".pypirc"
        || file_name == ".netrc"
        || file_name == "credentials.json"
        || file_name.ends_with(".kdbx")
        || file_name.starts_with("id_rsa")
        || file_name.starts_with("id_ed25519")
        || file_name.ends_with(".pem")
        || file_name.ends_with(".pfx")
        || file_name.ends_with(".p12")
        || file_name.ends_with(".key")
    {
        return true;
    }

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return false;
    }
    let home_l = home.replace('/', "\\").to_lowercase();
    let blocked = [
        ".ssh",
        ".aws",
        ".gnupg",
        ".config",
        ".kube",
        ".docker",
        "appdata\\local\\microsoft\\credentials",
        "appdata\\roaming\\microsoft\\credentials",
        // Master key DPAPI: đọc được là giải mã được prynx_license.dat ngoài phiên.
        "appdata\\roaming\\microsoft\\protect",
        "appdata\\local\\microsoft\\vault",
        // Profile trình duyệt (cookie/token đăng nhập).
        "appdata\\local\\google\\chrome\\user data",
        "appdata\\local\\microsoft\\edge\\user data",
        "appdata\\roaming\\mozilla\\firefox\\profiles",
    ];
    if blocked
        .iter()
        .any(|s| norm.starts_with(&format!("{}\\{}", home_l, s)))
    {
        return true;
    }

    // Credential DPAPI của chính PrynX: CHỈ chặn `*.dat` (đối xứng deny
    // `$HOME/AppData/Roaming/PrynX/*.dat`). KHÔNG chặn cả thư mục — recipe/preset của
    // app nằm ngay trong đó và đọc qua `read_dir_json` (chặn cả thư mục = giết luồng thật).
    let prynx_dir = format!("{}\\appdata\\roaming\\prynx", home_l);
    if norm.starts_with(&prynx_dir) && file_name.ends_with(".dat") {
        return true;
    }

    false
}

#[derive(serde::Serialize)]
struct UpscaleFileGrant {
    path: String,
    grant: String,
}

fn is_network_or_device_path(path: &str) -> bool {
    path.replace('/', "\\").starts_with(r"\\")
}

fn canonical_path_for_sidecar(path: &std::path::Path) -> Result<String, String> {
    let raw = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if raw.starts_with(r"\\?\UNC\") {
            return Err("Không hỗ trợ đường dẫn mạng cho Upscale".to_string());
        }
        if let Some(without_verbatim_prefix) = raw.strip_prefix(r"\\?\") {
            return Ok(without_verbatim_prefix.to_string());
        }
    }
    Ok(raw.into_owned())
}

#[tauri::command]
fn grant_upscale_file_path(
    app: tauri::AppHandle,
    file_path: String,
    tab_id: String,
) -> Result<UpscaleFileGrant, String> {
    // SEC (audit 2026-08-11 §UP.R.01): renderer không được tự biến một path tùy ý
    // thành fast-path. Scope này chỉ được Tauri nới khi người dùng chọn/kéo file.
    if file_path.is_empty()
        || is_network_or_device_path(&file_path)
        || is_sensitive_path(&file_path)
    {
        return Err("Không được phép cấp quyền cho đường dẫn này".to_string());
    }

    let source = std::path::PathBuf::from(&file_path);
    let source_metadata =
        std::fs::symlink_metadata(&source).map_err(|_| "Không tìm thấy ảnh đã chọn".to_string())?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("Đường dẫn ảnh không phải file thường".to_string());
    }

    let canonical = std::fs::canonicalize(&source)
        .map_err(|_| "Không chuẩn hóa được đường dẫn ảnh".to_string())?;
    if !app.fs_scope().is_allowed(&canonical) {
        return Err("Ảnh chưa được người dùng cấp quyền qua hộp chọn hoặc kéo-thả".to_string());
    }

    let path = canonical_path_for_sidecar(&canonical)?;
    if is_network_or_device_path(&path) || is_sensitive_path(&path) {
        return Err("Không được phép cấp quyền cho đường dẫn này".to_string());
    }
    let extension = std::path::Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    const UPSCALE_IMAGE_EXTENSIONS: [&str; 7] =
        ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];
    if !UPSCALE_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Định dạng ảnh không được Upscale hỗ trợ".to_string());
    }

    let grant = security::issue_upscale_file_grant(&path, &tab_id)?;
    Ok(UpscaleFileGrant { path, grant })
}

/// Guard RIÊNG cho GHI: ngoài các vị trí nhạy cảm dùng chung (is_sensitive_path),
/// chặn thêm thư mục hệ thống Windows/Program Files để renderer (nếu bị chèn mã) KHÔNG
/// ghi đè file hệ thống. KHÔNG gộp vào is_sensitive_path vì lệnh ĐỌC cần truy cập
/// C:\Windows\Fonts (đọc font hệ thống hợp lệ).
///
/// SEC (audit 2026-08-28 §SEC.04): phần so thư mục hệ thống bên dưới cũng TỪNG dùng
/// chuỗi thô nên `\\?\C:\Windows\...` lọt. Nay dùng chung `strip_path_prefix_aliases` và
/// so LẠI trên dạng canonical, đối xứng với `is_sensitive_path`.
/// Bổ sung Startup per-user: `fs:allow-write-file`/`fs:allow-mkdir` deny thư mục này
/// nhưng lệnh Rust không vướng ACL plugin-fs ⇒ trước đây ghi được, lệch với capability.
pub(crate) fn is_sensitive_write_path(path: &str) -> bool {
    if is_sensitive_path(path) {
        return true;
    }
    if is_sensitive_write_path_text(&strip_path_prefix_aliases(path)) {
        return true;
    }
    match std::fs::canonicalize(std::path::Path::new(path)) {
        Ok(resolved) => {
            let resolved_text = resolved.to_string_lossy();
            is_sensitive_write_path_text(&strip_path_prefix_aliases(&resolved_text))
        }
        // Đích GHI thường chưa tồn tại — đó là bình thường, không phải dấu hiệu tấn công.
        // Thư mục cha thì phải tồn tại, nên resolve cha để junction không qua được.
        Err(_) => match std::path::Path::new(path).parent() {
            Some(parent) => match std::fs::canonicalize(parent) {
                Ok(resolved_parent) => {
                    let parent_text = resolved_parent.to_string_lossy();
                    is_sensitive_write_path_text(&strip_path_prefix_aliases(&parent_text))
                }
                Err(_) => false,
            },
            None => false,
        },
    }
}

/// Phần so khớp thuần chuỗi cho guard GHI. Nhận chuỗi đã qua `strip_path_prefix_aliases`.
fn is_sensitive_write_path_text(norm: &str) -> bool {
    let mut sys_dirs: Vec<String> = Vec::new();
    for var in [
        "WINDIR",
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                sys_dirs.push(strip_path_prefix_aliases(&v));
            }
        }
    }
    if sys_dirs
        .iter()
        .any(|d| norm == *d || norm.starts_with(&format!("{}\\", d)))
    {
        return true;
    }

    // Startup per-user: ghi được vào đây là đường persistence. Allowlist đuôi của
    // `write_file_atomic` không có `.lnk/.exe/.bat` nên tác động thấp, nhưng giữ ba
    // danh sách (asset deny / fs deny / hàm này) đối xứng là điều kiện để ratchet CI
    // còn ý nghĩa — lệch âm thầm là cách lỗ cũ từng quay lại.
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return false;
    }
    let startup = format!(
        "{}\\appdata\\roaming\\microsoft\\windows\\start menu\\programs\\startup",
        strip_path_prefix_aliases(&home)
    );
    norm == startup || norm.starts_with(&format!("{}\\", startup))
}

#[derive(serde::Serialize)]
struct BatchFolderFile {
    path: String,
    name: String,
    size: u64,
}

fn supported_batch_extension(path: &std::path::Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "pdf"
            | "doc"
            | "docx"
            | "odt"
            | "rtf"
            | "xls"
            | "xlsx"
            | "ods"
            | "csv"
            | "ppt"
            | "pptx"
            | "odp"
    )
}

#[tauri::command]
fn list_batch_folder_files(folder: String) -> Result<Vec<BatchFolderFile>, String> {
    if is_sensitive_path(&folder) {
        return Err("Access to this location is not allowed".to_string());
    }
    let dir = std::path::Path::new(&folder);
    if !dir.is_dir() {
        return Err("Selected source is not a folder".to_string());
    }

    let mut files = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Cannot read folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !supported_batch_extension(&path) {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) if !name.starts_with("~$") => name.to_string(),
            _ => continue,
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        files.push(BatchFolderFile {
            path: path.to_string_lossy().to_string(),
            name,
            size,
        });
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

fn unique_batch_pdf_target(
    output_dir: &std::path::Path,
    preferred_name: &str,
) -> Result<std::path::PathBuf, String> {
    if !output_dir.is_dir() {
        return Err("Selected output is not a folder".to_string());
    }
    let safe_name = std::path::Path::new(preferred_name)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid output filename".to_string())?;
    if !safe_name.to_ascii_lowercase().ends_with(".pdf") {
        return Err("Batch output must be a PDF".to_string());
    }
    let stem = std::path::Path::new(safe_name)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("document");
    for index in 1..=10_000u32 {
        let name = if index == 1 {
            format!("{}.pdf", stem)
        } else {
            format!("{}_{}.pdf", stem, index)
        };
        let candidate = output_dir.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not allocate a unique output filename".to_string())
}

fn finish_batch_temp(
    temp: &std::path::Path,
    output_dir: &std::path::Path,
    preferred_name: &str,
) -> Result<String, String> {
    // Re-check after writing the temp file so existing results are never overwritten.
    for _ in 0..10_000 {
        let target = unique_batch_pdf_target(output_dir, preferred_name)?;
        // Windows rename fails when the destination already exists, providing
        // atomic publication without overwriting and working on FAT/SMB drives.
        #[cfg(windows)]
        match std::fs::rename(temp, &target) {
            Ok(()) => return Ok(target.to_string_lossy().to_string()),
            Err(_) if target.exists() => continue,
            Err(e) => return Err(format!("Cannot finalize output PDF: {}", e)),
        }
        // On Unix rename may replace an existing target, so use an atomic link.
        #[cfg(not(windows))]
        match std::fs::hard_link(temp, &target) {
            Ok(()) => {
                let _ = std::fs::remove_file(temp);
                return Ok(target.to_string_lossy().to_string());
            }
            Err(_) if target.exists() => continue,
            Err(e) => return Err(format!("Cannot finalize output PDF: {}", e)),
        }
    }
    Err("Could not allocate a unique output filename".to_string())
}

fn batch_temp_path(output_dir: &std::path::Path) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    output_dir.join(format!(".prynx_batch_{}_{}.tmp", std::process::id(), nanos))
}

fn ensure_batch_sink_allowed(window_label: &str) -> Result<(), String> {
    if document_window_registry::is_document_window_label(window_label) {
        return Err(
            "Cửa sổ tài liệu không được dùng lệnh xuất hàng loạt; hãy Lưu thành PDF mới."
                .to_string(),
        );
    }
    Ok(())
}

fn write_batch_pdf_impl(
    output_dir: String,
    preferred_name: String,
    contents: Vec<u8>,
) -> Result<String, String> {
    if is_sensitive_write_path(&output_dir) {
        return Err("Access to this location is not allowed".to_string());
    }
    if contents.len() < 4 || &contents[..4] != b"%PDF" {
        return Err("Converted output is not a valid PDF".to_string());
    }
    let dir = std::path::Path::new(&output_dir);
    let temp = batch_temp_path(dir);
    std::fs::write(&temp, contents).map_err(|e| format!("Cannot write temporary PDF: {}", e))?;
    let result = finish_batch_temp(&temp, dir, &preferred_name);
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn write_batch_pdf_for_window(
    window_label: &str,
    output_dir: String,
    preferred_name: String,
    contents: Vec<u8>,
) -> Result<String, String> {
    ensure_batch_sink_allowed(window_label)?;
    write_batch_pdf_impl(output_dir, preferred_name, contents)
}

#[tauri::command]
fn write_batch_pdf(
    window: tauri::WebviewWindow,
    output_dir: String,
    preferred_name: String,
    contents: Vec<u8>,
) -> Result<String, String> {
    // SEC (audit 2026-09-04 §SEC.15): child V1 không có UX batch hợp lệ. Chặn
    // theo caller native trước khi tạo bất kỳ `.prynx_batch_*.tmp` nào.
    write_batch_pdf_for_window(window.label(), output_dir, preferred_name, contents)
}

fn copy_batch_pdf_impl(
    source: String,
    output_dir: String,
    preferred_name: String,
) -> Result<String, String> {
    if is_sensitive_path(&source) || is_sensitive_write_path(&output_dir) {
        return Err("Access to this location is not allowed".to_string());
    }
    let source_path = std::path::Path::new(&source);
    if !source_path.is_file()
        || !source_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false)
    {
        return Err("Source is not a PDF file".to_string());
    }
    let dir = std::path::Path::new(&output_dir);
    let temp = batch_temp_path(dir);
    std::fs::copy(source_path, &temp).map_err(|e| format!("Cannot copy PDF: {}", e))?;
    let result = finish_batch_temp(&temp, dir, &preferred_name);
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn copy_batch_pdf_for_window(
    window_label: &str,
    source: String,
    output_dir: String,
    preferred_name: String,
) -> Result<String, String> {
    ensure_batch_sink_allowed(window_label)?;
    copy_batch_pdf_impl(source, output_dir, preferred_name)
}

#[tauri::command]
fn copy_batch_pdf(
    window: tauri::WebviewWindow,
    source: String,
    output_dir: String,
    preferred_name: String,
) -> Result<String, String> {
    copy_batch_pdf_for_window(window.label(), source, output_dir, preferred_name)
}
#[tauri::command]
fn read_system_file(path: String) -> Result<Response, String> {
    // Security: only allow known file types to prevent arbitrary file reads
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = [
        "pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "icc", "icm", "svg", "ttf",
        "otf", "ttc", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx",
        "odp", "json", "txt",
    ];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("File type .{} not allowed", ext));
    }
    if is_sensitive_path(&path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Lỗi đọc file từ Rust: {}", e))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    // SECURITY (audit 2026-07-26): thêm allowlist ĐUÔI FILE như read_system_file. Trước
    // đây lệnh này chỉ kiểm is_sensitive_path nên là ORACLE tồn-tại/kích-thước cho MỌI
    // file ngoài vài thư mục bị chặn. Consumer thật chỉ hỏi size của file người dùng mở
    // (PDF/ảnh/office) — xem PDFUploader.tsx, SystemIntegrations.tsx.
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = [
        "pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "icc", "icm", "svg", "ttf",
        "otf", "ttc", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx",
        "odp", "json", "txt",
    ];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("File type .{} not allowed", ext));
    }
    if is_sensitive_path(&path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Lỗi lấy metadata: {}", e))?;
    Ok(metadata.len())
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum SystemFileStatStatus {
    Available,
    Missing,
    Inaccessible,
}

#[derive(serde::Serialize)]
struct SystemFileStat {
    status: SystemFileStatStatus,
    size: u64,
}

fn classify_system_file_stat_error(
    error: &std::io::Error,
    parent_is_accessible: bool,
) -> SystemFileStatStatus {
    // FILEIO (audit 2026-08-02 §OPEN.2): NotFound chỉ đủ chắc khi thư mục cha vẫn
    // đọc được. Ổ USB chưa gắn hoặc share NAS offline cũng có thể trả NotFound.
    if error.kind() == std::io::ErrorKind::NotFound && parent_is_accessible {
        SystemFileStatStatus::Missing
    } else {
        SystemFileStatStatus::Inaccessible
    }
}

fn stat_system_file_blocking(file_path: &std::path::Path) -> SystemFileStat {
    match std::fs::metadata(file_path) {
        Ok(metadata) if metadata.is_file() => SystemFileStat {
            status: SystemFileStatStatus::Available,
            size: metadata.len(),
        },
        Ok(_) => SystemFileStat {
            status: SystemFileStatStatus::Inaccessible,
            size: 0,
        },
        Err(error) => {
            let parent_is_accessible = file_path
                .parent()
                .and_then(|parent| std::fs::metadata(parent).ok())
                .is_some_and(|metadata| metadata.is_dir());
            SystemFileStat {
                status: classify_system_file_stat_error(&error, parent_is_accessible),
                size: 0,
            }
        }
    }
}

#[tauri::command]
async fn stat_system_file(path: String) -> Result<SystemFileStat, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = [
        "pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "icc", "icm", "svg", "ttf",
        "otf", "ttc", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx",
        "odp", "json", "txt",
    ];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("File type .{} not allowed", ext));
    }
    if is_sensitive_path(&path) {
        return Err("Access to this location is not allowed".to_string());
    }

    // FILEIO (audit 2026-08-02 §OPEN.1): metadata NAS/UNC có thể chờ I/O lâu;
    // chạy ở blocking pool để không giữ luồng IPC/UI. Deadline UX nằm ở frontend
    // và chỉ ngừng chờ size, không hủy hay giới hạn công suất đọc file thật.
    tauri::async_runtime::spawn_blocking(move || {
        stat_system_file_blocking(std::path::Path::new(&path))
    })
    .await
    .map_err(|error| format!("Lỗi chạy tác vụ metadata: {error}"))
}

#[tauri::command]
fn delete_file_scoped(path: String) -> Result<(), String> {
    // RECIPE (audit 2026-08-17 §STORE.1): xóa file JSON do app quản lý (recipe...).
    // Capability KHÔNG có fs:allow-remove nên plugin-fs.remove bị ACL chặn; lệnh Rust
    // này không vướng scope đó. Chỉ cho .json, chặn vị trí nhạy cảm, không xóa thư mục.
    // Idempotent: file đã không còn cũng coi là thành công. Lỗi thật thì TRẢ VỀ Err để
    // FE fail-loud (không báo "đã xóa" giả như bug cũ).
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "json" {
        return Err(format!("File type .{} not allowed", ext));
    }
    if is_sensitive_write_path(&path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let target = std::path::Path::new(&path);
    if !target.is_file() {
        return Ok(());
    }
    std::fs::remove_file(target).map_err(|e| format!("Lỗi xóa file: {}", e))
}

fn create_atomic_save_temp(
    directory: &std::path::Path,
) -> Result<(std::path::PathBuf, std::fs::File), String> {
    use rand::RngCore;

    for _ in 0..32 {
        let mut nonce = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut nonce);
        let path = directory.join(format!(".prynx_save_{}.tmp", hex::encode(nonce)));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows::Win32::Storage::FileSystem::{
                DELETE, FILE_GENERIC_WRITE, FILE_SHARE_READ,
            };

            // SEC (audit 2026-09-04 §SEC.15-R2): handle vừa ghi vừa sở hữu
            // DELETE để tự publish, nhưng chỉ share READ. Process khác không thể
            // mở quyền ghi/delete hoặc rename path rồi tráo bytes trước publish.
            options
                .access_mode(FILE_GENERIC_WRITE.0 | DELETE.0)
                .share_mode(FILE_SHARE_READ.0);
        }
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Không tạo được file tạm độc quyền: {error}")),
        }
    }
    Err("Không cấp được tên file tạm ngẫu nhiên sau nhiều lần thử.".to_string())
}

struct PublishedAtomicSave {
    // Trên Windows, giữ handle đã publish (không share WRITE/DELETE) cho tới khi
    // lineage/staging grant đã ghi xong; tránh một race mới ngay sau rename.
    #[cfg(windows)]
    _handle: std::fs::File,
}

#[cfg(windows)]
fn publish_atomic_save_temp(
    temp_path: &std::path::Path,
    temp_file: std::fs::File,
    target: &std::path::Path,
) -> Result<PublishedAtomicSave, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    let temp_identity = windows_file_identity_from_handle(&temp_file)
        .ok_or_else(|| "Không đọc được định danh handle file tạm trước khi publish.".to_string())?;
    if windows_file_identity(temp_path) != Some(temp_identity) {
        return Err("Tên file tạm không còn trỏ đúng handle đang ghi.".to_string());
    }

    // FILE_RENAME_INFO với RootDirectory rỗng đòi tên đầy đủ. Resolve đúng parent
    // đang tồn tại rồi giữ nguyên basename để cả path tương đối của main window vẫn
    // có hành vi như std::fs::rename trước đây.
    let target_parent = target
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let canonical_parent = std::fs::canonicalize(target_parent)
        .map_err(|error| format!("Không chuẩn hóa được thư mục publish: {error}"))?;
    let target_name = target
        .file_name()
        .ok_or_else(|| "Đích publish không có tên file.".to_string())?;
    let absolute_target = canonical_parent.join(target_name);
    let target_wide = absolute_target
        .as_os_str()
        .encode_wide()
        .collect::<Vec<_>>();
    let filename_bytes = target_wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| "Đường dẫn publish vượt giới hạn Win32.".to_string())?;
    let filename_offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let buffer_bytes = filename_offset
        .checked_add(filename_bytes as usize)
        .ok_or_else(|| "Kích thước cấu trúc publish không hợp lệ.".to_string())?;
    let word_size = std::mem::size_of::<usize>();
    let word_count = buffer_bytes
        .checked_add(word_size - 1)
        .map(|size| size / word_size)
        .ok_or_else(|| "Kích thước cấu trúc publish không hợp lệ.".to_string())?;
    let mut storage = vec![0usize; word_count];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();

    // SAFETY:
    // - `storage` được cấp theo `usize`, đủ alignment cho FILE_RENAME_INFO và đủ
    //   `buffer_bytes` sau khi làm tròn; `target_wide` được copy đúng số byte đã khai;
    // - `temp_file` còn sống, được mở với quyền DELETE và không share DELETE/WRITE;
    // - API không giữ con trỏ sau lời gọi. Rename chạy trên chính handle này, không
    //   resolve lại `temp_path`, nên không còn cửa sổ path-swap của std::fs::rename.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = true;
        (*info).RootDirectory = HANDLE::default();
        (*info).FileNameLength = filename_bytes;
        std::ptr::copy_nonoverlapping(
            target_wide.as_ptr(),
            storage
                .as_mut_ptr()
                .cast::<u8>()
                .add(filename_offset)
                .cast::<u16>(),
            target_wide.len(),
        );
        SetFileInformationByHandle(
            HANDLE(temp_file.as_raw_handle() as _),
            FileRenameInfo,
            info.cast::<std::ffi::c_void>(),
            u32::try_from(buffer_bytes)
                .map_err(|_| "Kích thước cấu trúc publish vượt giới hạn Win32.".to_string())?,
        )
        .map_err(|error| format!("Win32 từ chối publish handle file tạm: {error}"))?;
    }

    if windows_file_identity_from_handle(&temp_file) != Some(temp_identity) {
        return Err("Handle file tạm đổi định danh trong lúc publish.".to_string());
    }
    Ok(PublishedAtomicSave { _handle: temp_file })
}

#[cfg(not(windows))]
fn publish_atomic_save_temp(
    temp_path: &std::path::Path,
    temp_file: std::fs::File,
    target: &std::path::Path,
) -> Result<PublishedAtomicSave, String> {
    // PrynX phát hành trên Windows; nhánh portable giữ nguyên semantics rename cũ.
    drop(temp_file);
    std::fs::rename(temp_path, target)
        .map(|_| PublishedAtomicSave {})
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_file_atomic(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    contents: Vec<u8>,
    save_grant: Option<String>,
) -> Result<(), String> {
    // GHI FILE NGUYÊN TỬ (chống hỏng/mất file gốc khi crash giữa lúc ghi đè).
    // Ghi ra file TẠM cùng thư mục; Windows publish bằng
    // SetFileInformationByHandle trên chính handle đang khóa, nền tảng khác giữ
    // rename(2). Lệnh Rust không vướng scope plugin-fs.
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = [
        "pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "svg", "csv", "txt", "json",
    ];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("File type .{} not allowed", ext));
    }
    if is_sensitive_write_path(&path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let requested_target = std::path::Path::new(&path);
    // SEC (audit 2026-09-04 §SEC.15): main giữ nguyên hành vi; riêng document-*
    // phải tiêu vé native one-shot bind caller + canonical target trước khi ghi temp.
    let save_target_lease = document_window_registry::consume_document_save_grant(
        &app,
        window.label(),
        requested_target,
        save_grant.as_deref(),
    )?;
    // Child ghi thẳng vào canonical target mà native đã cấp; không đi lại qua
    // junction cha do renderer giữ để tránh TOCTOU sau lúc consume grant.
    let target = save_target_lease
        .as_ref()
        .map(document_window_registry::SaveTargetLease::target)
        .unwrap_or(requested_target);
    let dir = match target.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let (tmp, mut temp_file) = create_atomic_save_temp(&dir)?;
    if let Err(e) = std::io::Write::write_all(&mut temp_file, &contents) {
        drop(temp_file);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi ghi file tạm: {}", e));
    }
    if let Err(e) = std::io::Write::flush(&mut temp_file) {
        drop(temp_file);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi hoàn tất file tạm: {}", e));
    }
    if let Some(lease) = &save_target_lease {
        if let Err(error) = lease.verify() {
            drop(temp_file);
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
    }
    let published_temp = match publish_atomic_save_temp(&tmp, temp_file, target) {
        Ok(published) => published,
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("Lỗi thay thế file đích: {error}"));
        }
    };
    if save_target_lease.is_some() {
        if let Err(error) =
            document_window_registry::record_document_saved_target(&app, window.label(), target)
        {
            // File đã publish nguyên tử; nếu window vừa destroy thì không còn consumer
            // để mở child tiếp. Không báo lưu thất bại giả sau khi bytes đã an toàn.
            log::warn!("[DOCUMENT-WINDOW] Không ghi được lineage file vừa lưu: {error}");
        }
    }
    drop(published_temp);
    Ok(())
}

/// FILEIO (audit 2026-08-26 §FILE.A4): dạng chuẩn hoá để so hai path trên đĩa.
///
/// Resolve phần đã tồn tại thật trước (đi qua junction/symlink/tên 8.3) rồi mới hạ
/// hoa/thường, vì NTFS không phân biệt hoa/thường và nhận cả hai dấu phân cách — so
/// chuỗi thô bỏ sót ca hai path khác mặt nhưng cùng một file.
pub(crate) fn disk_compare_key(path: &std::path::Path) -> String {
    let resolved = std::fs::canonicalize(path).ok().or_else(|| {
        // Đích chưa tồn tại: resolve thư mục cha rồi ghép lại tên file.
        let parent = std::fs::canonicalize(path.parent()?).ok()?;
        Some(parent.join(path.file_name()?))
    });
    resolved
        .unwrap_or_else(|| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase()
}

/// FILEIO (audit 2026-08-26 §FILE.A4): định danh file THẬT của Windows — bộ ba
/// `dwVolumeSerialNumber` + `nFileIndexHigh` + `nFileIndexLow` đọc từ
/// `BY_HANDLE_FILE_INFORMATION`.
///
/// Đây là oracle duy nhất Windows bảo đảm: hai path trùng cả ba trường thì mở ra CÙNG
/// một file, kể cả khi chuỗi path khác hẳn nhau vì hardlink, tên ngắn 8.3, junction,
/// symlink, hay ổ mạng đã map so với đường UNC của cùng share. So chuỗi canonical không
/// thấy được hardlink vì hai hardlink là hai tên hợp lệ khác nhau của một file.
///
/// Trả `None` nghĩa là KHÔNG KẾT LUẬN ĐƯỢC (không mở được handle vì quyền, file bị khoá
/// độc quyền, path không hợp lệ) — tuyệt đối KHÔNG phải "hai file khác nhau". Người gọi
/// phải xử lý `None` theo hướng fail-closed.
///
/// Handle được sở hữu bằng `std::fs::File` để `Drop` đóng chắc chắn trên mọi đường ra;
/// helper nhận `&File` để cùng một identity có thể được kiểm lại mà không resolve path.
pub(crate) type WindowsFileIdentity = (u32, u32, u32);

#[cfg(windows)]
pub(crate) fn windows_file_identity_from_handle(
    file: &std::fs::File,
) -> Option<WindowsFileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: tiền điều kiện của lời gọi Win32 này:
    // - caller giữ `file` sống suốt borrow này, nên raw handle chưa bị đóng;
    // - `info` là struct `#[repr(C)]` do chính crate `windows` khai báo, đã zero-init qua
    //   `Default` nên API ghi vào vùng nhớ có kích thước và layout đúng;
    // - không giữ lại con trỏ nào sau lời gọi: `&mut info` chỉ sống trong đúng lời gọi,
    //   và không có tham chiếu nào tới raw handle tồn tại sau lời gọi.
    let queried =
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle() as _), &mut info).is_ok() };
    if !queried {
        return None;
    }
    Some((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

#[cfg(windows)]
pub(crate) fn windows_file_identity(path: &std::path::Path) -> Option<WindowsFileIdentity> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    // `FILE_READ_ATTRIBUTES`: quyền nhỏ nhất đủ để truy vấn metadata — handle chỉ-đọc,
    // không xin quyền đọc bytes nên không đòi DACL rộng hơn mức cần.
    // Share mode ĐẦY ĐỦ (read | write | delete): oracle thông thường không được khóa
    // file mà người dùng đang mở ở Illustrator hay CorelDRAW. §SEC.15-R2 mở một
    // handle riêng với share mode khắt khe ở đúng vòng đời grant/publish.
    // `FILE_FLAG_BACKUP_SEMANTICS`: cần để mở được cả handle THƯ MỤC, vì path đi vào đây
    // có thể là junction hoặc thư mục chứ không chỉ file.
    // Không đặt `FILE_FLAG_OPEN_REPARSE_POINT` là cố ý: phải đi THEO reparse point để lấy
    // định danh của file thật ở cuối chuỗi link.
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
        .ok()?;
    windows_file_identity_from_handle(&file)
}

/// Nền tảng không phải Windows không có bộ ba volume serial + file index; trả `None` để
/// `resolves_to_same_disk_file` rơi về `disk_compare_key`. PrynX chỉ phát hành cho
/// Windows, nhánh này tồn tại để cây mã còn compile được ở môi trường khác.
#[cfg(not(windows))]
pub(crate) fn windows_file_identity(_path: &std::path::Path) -> Option<WindowsFileIdentity> {
    None
}

#[cfg(not(windows))]
pub(crate) fn windows_file_identity_from_handle(
    _file: &std::fs::File,
) -> Option<WindowsFileIdentity> {
    None
}

/// Nguồn và đích cùng trỏ một file trên đĩa.
///
/// FILEIO (audit 2026-08-26 §FILE.A4): ưu tiên định danh file thật, rơi về so chuỗi
/// canonical khi không kết luận được. Thứ tự ba bước là cố ý:
///
/// 1. Đích chưa tồn tại thì KHÔNG THỂ là file nguồn đang tồn tại (`validate_disk_copy_request`
///    đã chốt nguồn `is_file()` trước khi gọi vào đây) → trả `false` NGAY, trước khi mở
///    handle nào. Đây là đường đi của phần lớn lượt Save As (ghi ra file mới) nên chi phí
///    lượt lưu thường không đổi.
/// 2. Lấy định danh cả hai phía; trùng cả ba trường thì là cùng một file.
/// 3. Bất kỳ phía nào trả `None` thì KHÔNG kết luận "khác nhau" mà rơi về `disk_compare_key`.
///    Resolve thất bại không được biến thành giấy phép ghi đè lên artifact tạm — đây là
///    bất biến fail-closed, không phải chi tiết cài đặt.
pub(crate) fn resolves_to_same_disk_file(
    source: &std::path::Path,
    target: &std::path::Path,
) -> bool {
    // Dùng `symlink_metadata` chứ không `exists()`: nó không đi theo link, nên một symlink
    // treo vẫn được tính là "đích đã tồn tại" và đi tiếp vào so định danh, thay vì rơi ra
    // `false` (hướng cho phép ghi) chỉ vì đích của link không resolve được.
    if std::fs::symlink_metadata(target).is_err() {
        return false;
    }
    if let (Some(source_id), Some(target_id)) =
        (windows_file_identity(source), windows_file_identity(target))
    {
        return source_id == target_id;
    }
    let source_key = disk_compare_key(source);
    !source_key.is_empty() && source_key == disk_compare_key(target)
}

/// Điều kiện tiên quyết của copy đĩa→đĩa. Tách khỏi command vì `copy_file_atomic` cần
/// `AppHandle` nên không unit-test được, mà đây là biên tin cậy với WebView: bất biến
/// phải nằm ở đây chứ không chỉ ở component gọi nó.
fn validate_disk_copy_request(source: &str, path: &str) -> Result<(), String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = [
        "pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "svg", "csv", "txt", "json",
    ];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("File type .{} not allowed", ext));
    }
    let source_ext = std::path::Path::new(source)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if source_ext != ext || !allowed.contains(&source_ext.as_str()) {
        return Err("Source and destination file types must match an allowed type".to_string());
    }
    if is_sensitive_path(source) || is_sensitive_write_path(path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let source_path = std::path::Path::new(source);
    if !source_path.is_file() {
        return Err("Source file does not exist".to_string());
    }
    // Chặn sớm ca nguồn trùng đích, TRƯỚC khi chạm đĩa. Copy qua `.tmp` rồi rename
    // không làm mất bytes, nhưng nó trả Ok — và chính cái Ok đó cho luồng Save As gắn
    // identity "nguồn sạch" lên đúng file artifact tạm, rửa trắng provenance kết quả
    // rồi coi artifact là nguồn thật của khách. Lỗi nghiệp vụ này cố ý KHÔNG chứa
    // "not allowed"/"forbidden path" để nhánh fallback chọn lại vị trí ở
    // ImpositionTab không hiểu nhầm thành lỗi phạm vi ghi và mở lại hộp thoại.
    if resolves_to_same_disk_file(source_path, std::path::Path::new(path)) {
        return Err("Nguồn và đích là cùng một file; hãy chọn vị trí lưu khác.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn copy_file_atomic(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    source: String,
    path: String,
    save_grant: Option<String>,
) -> Result<(), String> {
    // COPY file đĩa→đĩa NGUYÊN TỬ, không đọc bytes vào JS. Vì sao: kết quả bình
    // sách/VDP là file lớn (hàng trăm MB) đã nằm trên đĩa; đường cũ đọc toàn bộ vào
    // JS rồi truyền Uint8Array qua IPC cho write_file_atomic → "RangeError: Invalid
    // array length" khi serialize khối bytes khổng lồ. Copy thẳng path→path tránh
    // hẳn round-trip đó. Ghi temp cùng thư mục đích rồi publish handle-nguyên-tử.
    let source_path = std::path::Path::new(&source);
    let requested_target = std::path::Path::new(&path);
    let canonical_staging_target =
        document_window_registry::validate_document_window_staging_target(requested_target)?;

    // SEC (audit 2026-08-28 §SEC.07): đích có tên staging của New Window sẽ được
    // `register_document_window_staging` cấp quyền MỘT LẦN để `create_document_window`
    // mở nó mà KHÔNG cần `fs_scope`. Nếu nguồn cũng không cần `fs_scope` thì renderer
    // tự hợp pháp hoá được một PDF ngoài phạm vi người dùng đã cấp: copy vào
    // `%TEMP%\prynx_print_new_window_<32hex>.pdf` rồi mở làm cửa sổ tài liệu — đúng thứ
    // mà comment ở `document_window_registry` tuyên bố là không thể.
    //
    // Chỉ siết ĐÚNG đường đặc quyền này; Save As bình thường vẫn ghi được ra vị trí
    // người dùng chọn mà không đòi scope (nếu đòi, luồng lưu kết quả sẽ vỡ).
    // Kiểm TRƯỚC khi copy để không để lại file rác ở `%TEMP%`.
    let save_target_lease = if canonical_staging_target.is_some() {
        document_window_registry::validate_document_window_staging_source(
            &app,
            window.label(),
            source_path,
        )?;
        None
    } else {
        document_window_registry::consume_document_save_grant(
            &app,
            window.label(),
            requested_target,
            save_grant.as_deref(),
        )?
    };
    let target = canonical_staging_target
        .as_deref()
        .or_else(|| {
            save_target_lease
                .as_ref()
                .map(document_window_registry::SaveTargetLease::target)
        })
        .unwrap_or(requested_target);
    validate_disk_copy_request(&source, &target.to_string_lossy())?;

    let dir = match target.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let mut source_file =
        std::fs::File::open(source_path).map_err(|e| format!("Lỗi mở file nguồn để copy: {e}"))?;
    let (tmp, mut temp_file) = create_atomic_save_temp(&dir)?;
    if let Err(e) = std::io::copy(&mut source_file, &mut temp_file) {
        drop(temp_file);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi copy file: {}", e));
    }
    if let Err(e) = std::io::Write::flush(&mut temp_file) {
        drop(temp_file);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi hoàn tất file tạm: {}", e));
    }
    if let Some(lease) = &save_target_lease {
        if let Err(error) = lease.verify() {
            drop(temp_file);
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
    }
    let published_temp = match publish_atomic_save_temp(&tmp, temp_file, target) {
        Ok(published) => published,
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("Lỗi thay thế file đích: {error}"));
        }
    };
    if canonical_staging_target.is_some() {
        if let Err(error) = document_window_registry::register_document_window_staging(
            &app,
            window.label(),
            source_path,
            target,
        ) {
            drop(published_temp);
            let _ = std::fs::remove_file(target);
            return Err(error);
        }
    } else if save_target_lease.is_some() {
        if let Err(error) =
            document_window_registry::record_document_saved_target(&app, window.label(), target)
        {
            log::warn!("[DOCUMENT-WINDOW] Không ghi được lineage file vừa copy: {error}");
        }
    }
    drop(published_temp);
    Ok(())
}

#[cfg(test)]
mod disk_copy_request_tests {
    use super::*;

    fn test_dir(label: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("prynx_{}_{}_{}", label, std::process::id(), stamp));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_save_temp_dung_nonce_128_bit_va_file_doc_quyen() {
        // SEC (audit 2026-09-04 §SEC.15): hai lần cấp phải tạo hai inode/path mới
        // ngay bằng create_new; không được chỉ tính tên PID + timestamp rồi mở lại.
        let dir = test_dir("atomic_temp_nonce");
        let (first_path, first_file) = create_atomic_save_temp(&dir).unwrap();
        let (second_path, second_file) = create_atomic_save_temp(&dir).unwrap();
        assert_ne!(first_path, second_path);
        for path in [&first_path, &second_path] {
            let name = path.file_name().unwrap().to_string_lossy();
            let nonce = name
                .strip_prefix(".prynx_save_")
                .and_then(|value| value.strip_suffix(".tmp"))
                .expect("tên temp phải có prefix/suffix cố định");
            assert_eq!(nonce.len(), 32, "nonce phải đủ 128-bit dạng hex");
            assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(path.is_file(), "create_new phải tạo file ngay khi cấp tên");
        }
        drop(first_file);
        drop(second_file);
        std::fs::remove_file(first_path).unwrap();
        std::fs::remove_file(second_path).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn atomic_save_temp_chan_ghi_rename_va_publish_bang_chinh_handle() {
        // SEC (audit 2026-09-04 §SEC.15-R2): reproducer cũ có thể mở lại path
        // temp để ghi bytes hoặc rename/tráo entry sau khi sink đã flush rồi trước
        // std::fs::rename. Handle mới giữ sharing contract xuyên qua publish.
        let dir = test_dir("atomic_temp_handle_publish");
        let target = dir.join("BanLuu.pdf");
        let renamed_temp = dir.join("temp_da_bi_trao.tmp");
        std::fs::write(&target, b"%PDF-old").unwrap();

        let (temp_path, mut temp_file) = create_atomic_save_temp(&dir).unwrap();
        std::io::Write::write_all(&mut temp_file, b"%PDF-new").unwrap();
        std::io::Write::flush(&mut temp_file).unwrap();

        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&temp_path)
                .is_err(),
            "process khác không được mở quyền ghi lên temp đang giữ handle"
        );
        assert!(
            std::fs::rename(&temp_path, &renamed_temp).is_err(),
            "process khác không được rename/delete temp đang giữ handle"
        );

        let published = publish_atomic_save_temp(&temp_path, temp_file, &target)
            .expect("SetFileInformationByHandle phải thay thế target hiện có");
        assert!(
            !temp_path.exists(),
            "entry temp phải được chuyển đi sau publish"
        );
        assert!(
            !renamed_temp.exists(),
            "không được publish qua path attacker"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-new");
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .is_err(),
            "handle đã publish phải tiếp tục khóa bytes cho tới lúc ghi lineage"
        );
        assert!(
            std::fs::rename(&target, dir.join("sau_publish.pdf")).is_err(),
            "handle đã publish phải khóa entry đích cho tới lúc ghi lineage"
        );
        drop(published);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn same_disk_file_is_rejected_before_touching_disk() {
        // Ca nguy hiểm của Save As: người dùng chọn đúng path artifact tạm làm đích lưu.
        let dir = test_dir("copy_same");
        let source = dir.join("artifact.pdf");
        std::fs::write(&source, b"%PDF-artifact").unwrap();
        let raw = source.to_string_lossy().to_string();

        // Ba mặt khác nhau của CÙNG một file: nguyên bản, đổi hoa/thường, đổi dấu
        // phân cách. Trên NTFS cả ba mở ra một file nên phải bị chặn như nhau.
        for candidate in [raw.clone(), raw.to_uppercase(), raw.replace('\\', "/")] {
            let error = validate_disk_copy_request(&raw, &candidate)
                .expect_err(&format!("phải chặn đích trùng nguồn: {candidate}"));
            assert!(
                error.contains("cùng một file"),
                "lỗi nghiệp vụ phải nói rõ nguồn trùng đích, nhận: {error}"
            );
            // Không được hiểu nhầm thành lỗi phạm vi ghi ở nhánh fallback frontend.
            assert!(!error.contains("not allowed"), "nhận: {error}");
            assert!(!error.contains("forbidden path"), "nhận: {error}");
        }

        // Chặn sớm nghĩa là chưa hề chạm đĩa: không có `.tmp` rơi lại, bytes còn nguyên.
        let entries = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec!["artifact.pdf".to_string()]);
        assert_eq!(std::fs::read(&source).unwrap(), b"%PDF-artifact");

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn distinct_destination_still_passes() {
        // Đối chứng âm: lưu ra file khác vẫn phải qua, kể cả khi đích chưa tồn tại.
        let dir = test_dir("copy_ok");
        let source = dir.join("artifact.pdf");
        std::fs::write(&source, b"%PDF-artifact").unwrap();
        let raw = source.to_string_lossy().to_string();

        for candidate in [
            dir.join("Hop_dong_khach.pdf"),
            dir.join("con").join("Hop_dong_khach.pdf"),
        ] {
            assert!(
                validate_disk_copy_request(&raw, &candidate.to_string_lossy()).is_ok(),
                "đích khác file không được chặn oan: {}",
                candidate.display()
            );
        }

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn existing_preconditions_still_hold() {
        // Hợp đồng cũ không được nới ra khi tách hàm: đuôi lệch, đuôi ngoài allow-list,
        // nguồn không tồn tại và path nhạy cảm vẫn phải chặn.
        let dir = test_dir("copy_pre");
        let source = dir.join("artifact.pdf");
        std::fs::write(&source, b"%PDF-artifact").unwrap();
        let raw = source.to_string_lossy().to_string();

        assert!(validate_disk_copy_request(&raw, &dir.join("out.exe").to_string_lossy()).is_err());
        assert!(validate_disk_copy_request(&raw, &dir.join("out.png").to_string_lossy()).is_err());
        assert!(validate_disk_copy_request(
            &dir.join("khong-co.pdf").to_string_lossy(),
            &dir.join("out.pdf").to_string_lossy()
        )
        .is_err());
        assert!(validate_disk_copy_request(&raw, "C:\\Windows\\System32\\out.pdf").is_err());

        std::fs::remove_dir_all(dir).unwrap();
    }

    /// FILEIO (audit 2026-08-26 §FILE.A4): liệt kê ĐỆ QUY tên tương đối của mọi entry
    /// trong `root`, đã sắp xếp.
    ///
    /// Vì sao snapshot cả cây chứ không chỉ `read_dir` một tầng: `copy_file_atomic` ghi
    /// file tạm `.<tên>.<pid>.<nanos>.tmp` vào THƯ MỤC ĐÍCH, nên bằng chứng "chặn trước khi
    /// chạm đĩa" phải soi được cả thư mục con. So hai snapshot trước/sau là cách chắc chắn
    /// nhất để bắt rác rơi lại, không phụ thuộc vào việc đoán đúng tên file tạm.
    #[cfg(windows)]
    fn snapshot_tree(root: &std::path::Path) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                out.push(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
                // `file_type()` KHÔNG đi theo reparse point, nên junction hiện ra là link
                // và vòng lặp không bao giờ đệ quy xuống thư mục thật đằng sau nó.
                if let Ok(kind) = entry.file_type() {
                    if kind.is_dir() && !kind.is_symlink() {
                        stack.push(path);
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// FILEIO (audit 2026-08-26 §FILE.A4): tạo junction `link` → `target` bằng `mklink /J`.
    ///
    /// `mklink` là builtin của `cmd` nên phải gọi qua `cmd /C`; junction (mount point) khác
    /// symlink ở chỗ KHÔNG cần `SeCreateSymbolicLinkPrivilege`, nên dựng được trên máy dev
    /// thường. Trả `false` khi môi trường không cho tạo — người gọi phải SKIP kèm thông báo
    /// rõ, tuyệt đối không hạ assert xuống mức yếu hơn rồi báo xanh.
    #[cfg(windows)]
    fn try_create_junction(link: &std::path::Path, target: &std::path::Path) -> bool {
        match std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(status) if status.success() => std::fs::symlink_metadata(link).is_ok(),
            Ok(status) => {
                eprintln!("mklink /J trả exit code {:?}", status.code());
                false
            }
            Err(error) => {
                eprintln!("không chạy được mklink /J: {error}");
                false
            }
        }
    }

    /// FILEIO (audit 2026-08-26 §FILE.A4): xoá junction mà KHÔNG xoá xuyên qua link.
    ///
    /// `remove_dir` tháo đúng reparse point; `remove_dir_all` trên đường đi qua junction là
    /// đường mất dữ liệu thật trong thư mục đích, nên test phải tháo link trước rồi mới dọn
    /// thư mục tạm.
    #[cfg(windows)]
    fn remove_junction(link: &std::path::Path) {
        if std::fs::symlink_metadata(link).is_ok() {
            std::fs::remove_dir(link).expect("phải tháo được junction bằng remove_dir");
        }
    }

    #[cfg(windows)]
    #[test]
    fn hardlink_alias_is_recognised_as_same_file() {
        // FILEIO (audit 2026-08-26 §FILE.A4) — Requirement 3.3.
        // Ca mà so chuỗi canonical KHÔNG THỂ thấy: hai hardlink là hai tên hợp lệ khác nhau
        // của CÙNG một file trên đĩa. Nếu Save As nhận một hardlink của artifact tạm làm
        // đích, copy đĩa→đĩa vẫn ghi lên chính file nguồn rồi trả Ok — đúng ca rửa trắng
        // provenance mà §FILE.A4 phát hiện.
        let dir = test_dir("copy_hardlink");
        let source = dir.join("artifact.pdf");
        std::fs::write(&source, b"%PDF-artifact").unwrap();
        let alias = dir.join("ban_luu_khach.pdf");
        if let Err(error) = std::fs::hard_link(&source, &alias) {
            eprintln!(
                "SKIP hardlink_alias_is_recognised_as_same_file: không tạo được hardlink ({error}) \
                 → ca hardlink của Requirement 3.3 còn là PROOF GAP trên môi trường này"
            );
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        // ASSERT THEN CHỐT của test này. Tầng so chuỗi canonical MÙ với hardlink: nếu ai hạ
        // `resolves_to_same_disk_file` về chỉ dùng `disk_compare_key` thì hai khoá dưới đây
        // vẫn khác nhau nên assert kế tiếp đỏ ngay. Không có assert_ne này, test vẫn xanh
        // sau khi oracle bị hạ cấp — tức là vô nghĩa.
        assert_ne!(
            disk_compare_key(&source),
            disk_compare_key(&alias),
            "tiền đề của test: so chuỗi canonical không nhận ra hardlink"
        );

        let source_id = windows_file_identity(&source);
        assert!(
            source_id.is_some(),
            "định danh file phải đọc được trên file thường, nếu None thì test xanh vô nghĩa"
        );
        assert_eq!(
            source_id,
            windows_file_identity(&alias),
            "hardlink phải trùng cả volume serial lẫn file index"
        );
        assert!(
            resolves_to_same_disk_file(&source, &alias),
            "oracle định danh phải nhận ra hardlink là cùng một file"
        );

        // Ba mặt path của cùng cái hardlink đều phải bị chặn ở biên tin cậy.
        let raw_source = source.to_string_lossy().to_string();
        let raw_alias = alias.to_string_lossy().to_string();
        for face in [
            raw_alias.clone(),
            raw_alias.to_uppercase(),
            raw_alias.replace('\\', "/"),
        ] {
            let error = validate_disk_copy_request(&raw_source, &face)
                .expect_err(&format!("phải chặn hardlink của nguồn: {face}"));
            assert!(
                error.contains("cùng một file"),
                "lỗi nghiệp vụ phải nói rõ nguồn trùng đích, nhận: {error}"
            );
        }

        // Đối chứng âm: file KHÁC thật trong cùng thư mục không được chặn oan.
        let other = dir.join("khac.pdf");
        std::fs::write(&other, b"%PDF-khac").unwrap();
        assert!(
            !resolves_to_same_disk_file(&source, &other),
            "hai file thật khác nhau không được coi là cùng một file"
        );
        assert!(
            validate_disk_copy_request(&raw_source, &other.to_string_lossy()).is_ok(),
            "đích là file khác thật phải qua được validate"
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn junction_alias_is_recognised_as_same_file() {
        // FILEIO (audit 2026-08-26 §FILE.A4) — Requirement 3.3.
        // Junction tới thư mục CHỨA artifact tạm: chuỗi path khác hẳn nhưng mở ra cùng file.
        // Khác hardlink, ca này ĐƯỢC CẢ HAI TẦNG nhận ra (canonicalize đi qua reparse point),
        // nên nó là hợp đồng hồi quy cho tầng fallback; sức phân biệt cho oracle định danh
        // nằm ở `hardlink_alias_is_recognised_as_same_file`.
        let dir = test_dir("copy_junction");
        let real = dir.join("that");
        std::fs::create_dir_all(&real).unwrap();
        let source = real.join("artifact.pdf");
        std::fs::write(&source, b"%PDF-artifact").unwrap();

        let link = dir.join("loi_tat");
        if !try_create_junction(&link, &real) {
            eprintln!(
                "SKIP junction_alias_is_recognised_as_same_file: môi trường không tạo được junction \
                 → ca junction của Requirement 3.3 còn là PROOF GAP trên môi trường này"
            );
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let alias = link.join("artifact.pdf");

        let source_id = windows_file_identity(&source);
        assert!(
            source_id.is_some(),
            "định danh file phải đọc được trên file thường, nếu None thì test xanh vô nghĩa"
        );
        assert_eq!(
            source_id,
            windows_file_identity(&alias),
            "đường qua junction phải cho cùng volume serial và file index"
        );
        assert_eq!(
            disk_compare_key(&source),
            disk_compare_key(&alias),
            "tầng fallback cũng phải resolve qua junction, đây là hợp đồng của disk_compare_key"
        );
        assert!(
            resolves_to_same_disk_file(&source, &alias),
            "đường qua junction phải bị nhận ra là cùng một file"
        );

        let raw_source = source.to_string_lossy().to_string();
        let error = validate_disk_copy_request(&raw_source, &alias.to_string_lossy())
            .expect_err("phải chặn đích trỏ qua junction về chính nguồn");
        assert!(
            error.contains("cùng một file"),
            "lỗi nghiệp vụ phải nói rõ nguồn trùng đích, nhận: {error}"
        );

        // Đối chứng âm: file khác thật, cũng đi qua junction, vẫn phải qua được.
        std::fs::write(real.join("khac.pdf"), b"%PDF-khac").unwrap();
        assert!(
            validate_disk_copy_request(&raw_source, &link.join("khac.pdf").to_string_lossy())
                .is_ok(),
            "đích khác file dù đi qua junction cũng không được chặn oan"
        );

        // Tháo junction TRƯỚC khi dọn, rồi khẳng định file thật còn nguyên — bằng chứng là
        // đã xoá đúng reparse point chứ không xoá xuyên qua link.
        remove_junction(&link);
        assert!(
            source.is_file(),
            "tháo junction không được làm mất file thật đằng sau nó"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn rejected_alias_request_leaves_disk_untouched() {
        // FILEIO (audit 2026-08-26 §FILE.A4) — Requirements 2.1, 2.2, 4.2, 4.4.
        // `same_disk_file_is_rejected_before_touching_disk` đã phủ ca đích TRÙNG CHUỖI với
        // nguồn. Test này phủ phần còn thiếu: ca đích là ALIAS mà chỉ oracle định danh mới
        // thấy (hardlink), tức là đường đi mới thêm ở task 4.2 cũng phải chặn TRƯỚC khi chạm
        // đĩa, cả hai chiều nguồn↔đích, và soi rác đệ quy chứ không chỉ một tầng.
        let dir = test_dir("copy_alias_intact");
        let source = dir.join("artifact.pdf");
        std::fs::write(&source, b"%PDF-artifact").unwrap();
        let alias = dir.join("ban_luu_khach.pdf");
        if let Err(error) = std::fs::hard_link(&source, &alias) {
            eprintln!(
                "SKIP rejected_alias_request_leaves_disk_untouched: không tạo được hardlink ({error}) \
                 → bằng chứng đĩa nguyên vẹn cho ca alias còn là PROOF GAP trên môi trường này"
            );
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        std::fs::create_dir_all(dir.join("con")).unwrap();

        let raw_source = source.to_string_lossy().to_string();
        let raw_alias = alias.to_string_lossy().to_string();
        let before = snapshot_tree(&dir);
        let bytes_before = std::fs::read(&source).unwrap();

        // Cả hai chiều: quan hệ cùng-một-file đối xứng nên biên tin cậy phải chặn như nhau.
        for (from, to) in [
            (raw_source.clone(), raw_alias.clone()),
            (raw_alias.clone(), raw_source.clone()),
            (raw_source.clone(), raw_alias.to_uppercase()),
            (raw_source.clone(), raw_alias.replace('\\', "/")),
        ] {
            let error = validate_disk_copy_request(&from, &to)
                .expect_err(&format!("phải chặn cặp alias: {from} → {to}"));
            // Thông báo cố ý KHÔNG mang hai chuỗi mà ImpositionTab dùng để nhận diện lỗi
            // phạm vi ghi, nếu không nhánh fallback sẽ mở lại hộp thoại chọn vị trí.
            assert!(!error.contains("not allowed"), "nhận: {error}");
            assert!(!error.contains("forbidden path"), "nhận: {error}");
        }

        // Chặn sớm nghĩa là cây thư mục không đổi một entry nào và không có `.tmp` rơi lại.
        let after = snapshot_tree(&dir);
        assert_eq!(before, after, "từ chối không được thêm hay bớt entry nào");
        assert!(
            after.iter().all(|name| !name.ends_with(".tmp")),
            "không được để lại file tạm: {after:?}"
        );
        assert_eq!(
            std::fs::read(&source).unwrap(),
            bytes_before,
            "bytes artifact nguồn phải nguyên vẹn sau khi từ chối"
        );

        // Đối chứng âm cho Requirement 4.4: đích CHƯA tồn tại trong thư mục con vẫn qua.
        assert!(
            validate_disk_copy_request(
                &raw_source,
                &dir.join("con").join("Hop_dong_khach.pdf").to_string_lossy()
            )
            .is_ok(),
            "đích chưa tồn tại trong thư mục con không được chặn oan"
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    // Feature: save-as-artifact-guard, Property 7: Fail-closed khi không kết luận được
    // **Validates: Requirements 3.5**
    #[cfg(windows)]
    #[test]
    fn identity_unavailable_falls_back_to_compare_key() {
        // FILEIO (audit 2026-08-26 §FILE.A4).
        // `windows_file_identity` trả `None` nghĩa là KHÔNG KẾT LUẬN ĐƯỢC, không phải "hai
        // file khác nhau". Biến `None` thành `false` là biến một lần resolve thất bại thành
        // giấy phép ghi đè lên artifact tạm — đúng lỗ hổng mà chốt chặn này tồn tại để bịt.
        let dir = test_dir("copy_failclosed");
        let real = dir.join("artifact.pdf");
        std::fs::write(&real, b"%PDF-artifact").unwrap();

        // Chốt trước: cơ chế định danh CÓ hoạt động trên file thường. Không có assert này,
        // mọi assert dưới đây vẫn xanh khi `windows_file_identity` bị vô hiệu hoá thành
        // `None` cho mọi path.
        assert!(
            windows_file_identity(&real).is_some(),
            "định danh file phải đọc được trên file thường, nếu None thì test xanh vô nghĩa"
        );

        // Dựng ca "không kết luận được" một cách XÁC ĐỊNH và không cần quyền đặc biệt:
        // junction TREO. Reparse point còn trên đĩa nên `symlink_metadata` thấy (không rơi ra
        // ở bước đích-chưa-tồn-tại), nhưng mở handle phải đi theo link tới thư mục đã bị xoá
        // nên chắc chắn thất bại → định danh trả `None`.
        let gone = dir.join("thu_muc_se_xoa");
        std::fs::create_dir_all(&gone).unwrap();
        let ghost = dir.join("junction_treo");
        if !try_create_junction(&ghost, &gone) {
            eprintln!(
                "SKIP identity_unavailable_falls_back_to_compare_key: môi trường không tạo được junction \
                 → ca fail-closed khi không resolve được (Requirement 3.5) còn là PROOF GAP"
            );
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        std::fs::remove_dir(&gone).unwrap();

        assert!(
            std::fs::symlink_metadata(&ghost).is_ok(),
            "junction treo phải còn hiện trên đĩa, nếu không test đi sai nhánh"
        );
        assert!(
            windows_file_identity(&ghost).is_none(),
            "tiền đề của test: junction treo không mở được handle nên phải cho None"
        );

        // Bất biến của Property 7: `None` vẫn phải đi tiếp bằng `disk_compare_key`. Ba mặt
        // path của cùng cái junction treo đều phải cho ra `true` — hạ `None` thành `false`
        // là ba assert này đỏ.
        let raw_ghost = ghost.to_string_lossy().to_string();
        for face in [
            raw_ghost.clone(),
            raw_ghost.to_uppercase(),
            raw_ghost.replace('\\', "/"),
        ] {
            assert!(
                resolves_to_same_disk_file(&ghost, std::path::Path::new(&face)),
                "không kết luận được thì phải rơi về so chuỗi chuẩn hoá, không được trả false: {face}"
            );
        }

        // Mặt còn lại của cùng bất biến: fail-closed không được thành chặn oan. Một phía
        // `None` mà khoá chuẩn hoá khác nhau thì vẫn là hai file khác nhau.
        assert!(
            !resolves_to_same_disk_file(&real, &ghost),
            "một phía None không được biến thành 'cùng một file' khi khoá chuẩn hoá khác nhau"
        );

        remove_junction(&ghost);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tauri::command]
fn read_dir_json(app: tauri::AppHandle, dir: String) -> Result<Vec<String>, String> {
    // Đọc nội dung MỌI file .json trong thư mục, trả Vec<String> (mỗi phần tử = nội
    // dung 1 file). Lệnh Rust → KHÔNG vướng scope plugin-fs (giống write_file_atomic).
    // Vì sao cần: readDir của plugin-fs bị chặn scope trên $APPDATA → recipe/preset đã
    // ghi ra đĩa nhưng panel không liệt kê được (bug 2026-07-08). Ghi qua Rust, đọc cũng
    // qua Rust → nhất quán, hết class lỗi scope.
    //
    // SECURITY (audit 2026-07-26): trước đây lệnh này KHÔNG kiểm gì cả → WebView bị chèn
    // mã có thể `invoke('read_dir_json', { dir: '<bất kỳ>' })` và lấy nội dung MỌI file
    // .json trên máy (vd `.aws\sso\cache\*.json` chứa bearer token, `.docker\config.json`),
    // ĐI VÒNG cả deny-list của assetProtocol lẫn của plugin-fs. Nay giới hạn đúng nhu cầu
    // thật: cả 3 consumer (recipeStore, presetManager, appSettingsStore) chỉ đọc thư mục
    // con của `appDataDir()`, nên chỉ cho phép trong cây đó.
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Không xác định được app data dir: {}", e))?;
    let requested = std::path::Path::new(&dir);
    // So sánh sau khi chuẩn hoá về chữ thường + dấu phân cách Windows; `..` đã bị
    // is_sensitive_path chặn nên không thể trèo ra ngoài bằng traversal.
    let norm = |p: &std::path::Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    let base = norm(&app_data);
    let target = norm(requested);
    let inside = target == base.trim_end_matches('\\')
        || target.starts_with(&format!("{}\\", base.trim_end_matches('\\')));
    if !inside || is_sensitive_path(&dir) {
        log::warn!("[SECURITY] read_dir_json bị từ chối (ngoài app data dir)");
        return Err("Access to this location is not allowed".to_string());
    }
    let path = std::path::Path::new(&dir);
    if !path.is_dir() {
        return Ok(Vec::new()); // thư mục chưa tồn tại → coi như rỗng, không phải lỗi
    }
    let entries = std::fs::read_dir(path).map_err(|e| format!("Lỗi đọc thư mục: {}", e))?;
    let mut out: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let is_json = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if is_json {
            if let Ok(content) = std::fs::read_to_string(&p) {
                out.push(content);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn take_pending_system_file_batches(state: tauri::State<SystemFilesState>) -> Vec<SystemFileBatch> {
    // FILEIO (audit 2026-08-26 §FILE.A2): giữ ranh giới argv từng process để
    // action của một lần Explorer launch không áp nhầm sang batch kế bên.
    state.drain_pending()
}

#[tauri::command]
fn get_pending_system_files(state: tauri::State<SystemFilesState>) -> Vec<String> {
    // Tương thích frontend cũ: chỉ đường legacy mới làm phẳng các batch.
    state
        .drain_pending()
        .into_iter()
        .flat_map(|batch| batch.args)
        .collect()
}

#[tauri::command]
async fn normalize_image_to_png(file_path: String) -> Result<tauri::ipc::Response, String> {
    if is_sensitive_path(&file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&file_path).map_err(|e| format!("Failed to open image: {}", e))?;
        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode image: {}", e))?;
        Ok(tauri::ipc::Response::new(buffer.into_inner()))
    })
    .await
    .unwrap_or_else(|_| Err("Task panicked".to_string()))
}

#[tauri::command]
async fn normalize_image_bytes(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("Failed to load image from memory: {}", e))?;
        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode image: {}", e))?;
        Ok(tauri::ipc::Response::new(buffer.into_inner()))
    })
    .await
    .unwrap_or_else(|_| Err("Task panicked".to_string()))
}

// ══════════════════════════════════════════════════════════════
// VECTOR #3 FIX: Sidecar binary integrity verification
// Computes SHA-256 of the Python sidecar and compares against
// the expected hash. Prevents binary replacement attacks.
// ══════════════════════════════════════════════════════════════

/// Compute SHA-256 hash of a file
#[cfg(not(debug_assertions))]
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open sidecar binary: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| format!("Cannot read sidecar binary: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Verify sidecar binary integrity.
/// In development, we skip the check (hash changes on every rebuild).
/// In production, set PRYNX_SIDECAR_HASH at build time.
#[cfg(not(debug_assertions))]
fn verify_sidecar_integrity(sidecar_path: &std::path::Path) -> Result<(), String> {
    // Expected hash is embedded at compile time.
    // Set via: PRYNX_SIDECAR_HASH=<hash> cargo build --release
    let expected_hash = option_env!("PRYNX_SIDECAR_HASH").unwrap_or("");

    if expected_hash.is_empty() {
        return Err("PRYNX_SIDECAR_HASH not set at build time. \
             Set env var before running cargo build --release."
            .to_string());
    }

    // FAIL-CLOSED: không đọc được file sidecar = từ chối khởi động. Trên máy khách bình
    // thường file LUÔN nằm cạnh .exe nên đọc-lỗi gần như chỉ xảy ra khi bị nghịch (đổi
    // tên/chặn quyền đọc để né integrity check). Trước đây nhánh này return Ok(()) →
    // cracker chỉ cần làm sha256_file lỗi là bỏ qua toàn bộ check mà KHÔNG cần khớp hash.
    // Log kèm path để nếu brick oan (AV cách ly, path lạ) thì dev chẩn đoán được ngay.
    let actual_hash = match sha256_file(sidecar_path) {
        Ok(h) => h,
        Err(e) => {
            log::error!(
                "[INTEGRITY] Cannot hash sidecar at {} ({}); refusing to start (fail-closed).",
                sidecar_path.display(),
                e
            );
            return Err(format!(
                "Security error: cannot verify backend integrity ({}). \
                 The backend file may be missing, quarantined by antivirus, or tampered with.",
                e
            ));
        }
    };
    if actual_hash != expected_hash {
        log::error!(
            "[INTEGRITY] Sidecar binary has been tampered! Expected={}, Got={}",
            expected_hash,
            actual_hash
        );
        return Err(format!(
            "Security error: backend binary integrity check failed. \
             The application may have been tampered with."
        ));
    }

    log::info!("[INTEGRITY] Sidecar binary integrity verified OK");
    Ok(())
}

// ══════════════════════════════════════════════════════════════
// VECTOR #4+#10 FIX: Frontend integrity check — hash ALL dist files.
// Hashing only index.html is bypassed by modifying JS bundles in assets/.
// Now we hash every file in dist/ recursively and compare combined hash.
// ══════════════════════════════════════════════════════════════
#[cfg(not(debug_assertions))]
fn verify_frontend_integrity(app: &tauri::App) -> Result<(), String> {
    let expected_hash = option_env!("PRYNX_FRONTEND_HASH").unwrap_or("");

    if expected_hash.is_empty() {
        return Err("PRYNX_FRONTEND_HASH not set at build time. \
             Set env var before running cargo build --release."
            .to_string());
    }

    // Frontend dist is in the resource directory
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot find resource dir: {}", e))?;

    // Try multiple possible dist locations
    // FAIL-CLOSED: nếu KHÔNG tìm thấy nơi chứa frontend (dist/ hoặc index.html) thì
    // KHÔNG cho qua — đây là dấu hiệu bị nghịch (đổi tên/di dời file để né check).
    // Bản cài hợp lệ LUÔN có dist ở resource_dir; thiếu = bất thường → chặn khởi động.
    // Tauri v2 NHÚNG frontend vào trong binary (asset resolver), KHÔNG copy dist/ ra
    // resource_dir trên đĩa. Nên bản cài production KHÔNG có dist/ lẫn index.html rời —
    // trường hợp này là BÌNH THƯỜNG, phải SKIP (frontend đã được bảo vệ bởi tính toàn vẹn
    // của chính binary + chữ ký updater). Trước đây siết fail-closed ở đây khiến app tự
    // từ chối khởi động ("dist dir not found — refusing to start") trên MỌI bản cài
    // (bug beta.8 2026-07-08). Chỉ verify khi dist/ THỰC SỰ có trên đĩa (dev/portable).
    let dist_dir = if resource_dir.join("dist").is_dir() {
        resource_dir.join("dist")
    } else if resource_dir.join("index.html").exists() {
        resource_dir.clone()
    } else {
        // ĐỪNG NHẦM: đây KHÔNG phải "đã kiểm tra và OK". Trên bản NSIS đã cài, nhánh này
        // LUÔN chạy (Tauri nhúng dist vào binary) ⇒ hash directory KHÔNG bao giờ được so
        // ⇒ VECTOR #4/#10 (patch JS bundle) THỰC TẾ KHÔNG ĐƯỢC PHỦ bởi hàm này.
        // Audit 2026-07-25: nói thẳng trạng thái thay vì log warn mờ rồi Ok().
        // Phần còn giữ giá trị: nếu kẻ nghịch THÊM dist/ hoặc index.html ra đĩa để tráo
        // frontend, nhánh trên sẽ bắt buộc khớp hash → cửa "shadowing" vẫn đóng.
        // Bù trừ (detect, không prevent): log SHA-256 của chính exe đang chạy để support
        // đối chiếu với release-manifest.txt do build_production.ps1 phát hành.
        log::warn!(
            "[INTEGRITY][POSTURE] Frontend embedded in binary (no dist/ under {}) — \
             directory hash check DOES NOT APPLY. Patched-JS detection relies on \
             executable integrity, which requires Authenticode code signing (not enabled).",
            resource_dir.display()
        );
        log_self_exe_hash();
        return Ok(());
    };

    // Hash ALL files in dist/ recursively, sorted by path for determinism
    let actual_hash = sha256_directory(&dist_dir)?;
    if actual_hash != expected_hash {
        log::error!(
            "[INTEGRITY] Frontend tampered! Expected={}, Got={}",
            expected_hash,
            actual_hash
        );
        return Err("Security error: frontend files have been tampered with.".to_string());
    }

    log::info!("[INTEGRITY] Frontend integrity verified OK (full directory hash)");
    Ok(())
}

/// Log SHA-256 của chính executable đang chạy (audit 2026-07-25).
///
/// Vì sao chỉ LOG mà không so sánh: hash của exe không thể nhúng vào chính exe đó
/// (chicken-egg) và app hiện KHÔNG được code-sign, nên không có neo tin cậy để verify
/// tại runtime. Lớp này là PHÁT HIỆN, không phải NGĂN CHẶN: support đối chiếu giá trị
/// trong log với `Ban_Phat_Hanh\release-manifest.txt` (build_production.ps1 phát hành)
/// để biết máy khách có đang chạy đúng binary đã phát hành hay không.
/// Cách bịt hẳn: bật Authenticode code signing rồi verify bằng WinVerifyTrust.
#[cfg(not(debug_assertions))]
fn log_self_exe_hash() {
    match std::env::current_exe() {
        Ok(exe) => match sha256_file(&exe) {
            Ok(hash) => log::warn!("[INTEGRITY][SELF] exe={} sha256={}", exe.display(), hash),
            Err(e) => log::warn!("[INTEGRITY][SELF] cannot hash exe: {}", e),
        },
        Err(e) => log::warn!("[INTEGRITY][SELF] cannot resolve exe path: {}", e),
    }
}

/// Hash all files in a directory recursively, sorted by relative path.
#[cfg(not(debug_assertions))]
fn sha256_directory(dir: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    collect_files(dir, &mut paths)?;
    paths.sort(); // Deterministic order

    let mut hasher = Sha256::new();
    for path in &paths {
        // Include relative path in hash (prevents file swap attacks)
        let rel = path.strip_prefix(dir).unwrap_or(path);
        hasher.update(rel.to_string_lossy().as_bytes());

        // Include file content
        let mut file = std::fs::File::open(path)
            .map_err(|e| format!("Cannot open {}: {}", path.display(), e))?;
        let mut buffer = [0u8; 8192];
        loop {
            use std::io::Read;
            let n = file
                .read(&mut buffer)
                .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
    }

    Ok(hex::encode(hasher.finalize()))
}

#[cfg(not(debug_assertions))]
fn collect_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("Cannot read dir {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod pdf_user_unit_tests {
    use super::{
        collect_pdf_user_units, collect_physical_page_dimensions, encode_viewer_png,
        lopdf_decompression_limit_for_total_ram, lopdf_load_options_for_total_ram,
        parse_pdf_structure, physical_page_dimension, tile_disk_path, tile_render_cache_key,
        validate_pdf_user_unit_page_count, viewer_render_scale, PdfFileIdentity,
        DEFAULT_PDF_USER_UNIT, GIB, LOW_RAM_LOPDF_STREAM_LIMIT, MID_RAM_LOPDF_STREAM_LIMIT,
    };
    use lopdf::{dictionary, Document, Object};

    fn parsed_document_with_user_units() -> Document {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let indirect_unit_id = document.add_object(Object::Real(2.5));

        let page_one_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 50.into()],
            "UserUnit" => 2,
        });
        let page_two_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 50.into()],
            "UserUnit" => indirect_unit_id,
        });
        let page_three_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 50.into()],
            "UserUnit" => 0,
        });
        let page_four_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 50.into()],
        });

        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![
                    page_one_id.into(),
                    page_two_id.into(),
                    page_three_id.into(),
                    page_four_id.into(),
                ],
                "Count" => 4,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let mut bytes = Vec::new();
        document
            .save_to(&mut bytes)
            .expect("ghi PDF kiểm thử vào bộ nhớ");
        Document::load_mem(&bytes).expect("đọc lại PDF kiểm thử")
    }

    #[test]
    fn doc_user_unit_duoc_doc_theo_tung_trang_va_gia_tri_sai_ve_mac_dinh() {
        let document = parsed_document_with_user_units();

        assert_eq!(
            collect_pdf_user_units(&document),
            vec![2.0, 2.5, DEFAULT_PDF_USER_UNIT, DEFAULT_PDF_USER_UNIT]
        );
    }

    #[test]
    fn metadata_va_render_cung_ap_dung_user_unit_mot_lan() {
        assert_eq!(physical_page_dimension(100.0, 2.0, 595.0), 200.0);
        assert_eq!(physical_page_dimension(50.0, 2.0, 842.0), 100.0);
        assert_eq!(physical_page_dimension(0.0, 2.0, 595.0), 595.0);

        let expected_scale = (96.0_f32 / 72.0) * 2.0;
        assert!((viewer_render_scale(1.0, 2.0) - expected_scale).abs() < f32::EPSILON);
    }

    #[test]
    fn transport_png_giu_nguyen_tung_pixel_va_cache_dung_duoi_moi() {
        let rgba = image::RgbaImage::from_raw(
            2,
            2,
            vec![
                0, 128, 255, 255, 17, 34, 51, 255, 240, 120, 3, 255, 255, 255, 255, 0,
            ],
        )
        .unwrap();

        let encoded = encode_viewer_png(&rgba).unwrap();
        assert_eq!(&encoded[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(image::load_from_memory(&encoded).unwrap().to_rgba8(), rgba);
        assert_eq!(
            tile_disk_path("viewer-lossless-test")
                .extension()
                .and_then(|value| value.to_str()),
            Some("png")
        );
    }

    #[test]
    fn parser_loi_va_so_trang_lech_deu_dung_an_toan() {
        let parse_error = parse_pdf_structure(b"khong-phai-pdf", None).unwrap_err();
        assert!(parse_error.contains("Không thể đọc cấu trúc trang PDF an toàn"));

        let mismatch_error = validate_pdf_user_unit_page_count(vec![1.0], 2).unwrap_err();
        assert!(mismatch_error.contains("không nhất quán"));
        assert_eq!(
            validate_pdf_user_unit_page_count(vec![1.0, 2.0], 2).unwrap(),
            vec![1.0, 2.0]
        );
    }

    #[test]
    fn gioi_han_giai_nen_lopdf_chi_ap_dung_cho_may_it_ram() {
        assert_eq!(
            lopdf_decompression_limit_for_total_ram(Some(4 * GIB)),
            Some(LOW_RAM_LOPDF_STREAM_LIMIT)
        );
        assert_eq!(
            lopdf_decompression_limit_for_total_ram(Some(8 * GIB)),
            Some(MID_RAM_LOPDF_STREAM_LIMIT)
        );
        assert_eq!(
            lopdf_decompression_limit_for_total_ram(Some(15 * GIB)),
            Some(MID_RAM_LOPDF_STREAM_LIMIT)
        );
        assert_eq!(
            lopdf_decompression_limit_for_total_ram(Some(16 * GIB)),
            None
        );
        assert_eq!(
            lopdf_decompression_limit_for_total_ram(Some(64 * GIB)),
            None
        );
        assert_eq!(lopdf_decompression_limit_for_total_ram(None), None);
        assert_eq!(
            lopdf_load_options_for_total_ram(Some(4 * GIB)).max_decompressed_size,
            Some(LOW_RAM_LOPDF_STREAM_LIMIT)
        );
    }

    #[test]
    fn metadata_van_doc_kich_thuoc_sau_trang_2000() {
        let page_count = 2_001_u16;
        let user_units = vec![1.0; page_count as usize];
        let mut last_page_read = None;

        let dimensions =
            collect_physical_page_dimensions(page_count, &user_units, 595.0, 842.0, |page_index| {
                last_page_read = Some(page_index);
                if page_index == 2_000 {
                    Some((321.0, 654.0))
                } else {
                    Some((100.0, 200.0))
                }
            })
            .unwrap();

        assert_eq!(last_page_read, Some(2_000));
        assert_eq!(dimensions.len(), 2_001);
        assert_eq!(dimensions[2_000], (321.0, 654.0));
    }

    #[test]
    fn tile_cache_tach_rieng_hai_noi_dung_cung_duong_dan() {
        let old_identity = PdfFileIdentity {
            size: 1_024,
            modified_nanos: 10,
            created_nanos: Some(1),
        };
        let new_identity = PdfFileIdentity {
            size: 2_048,
            modified_nanos: 20,
            created_nanos: Some(2),
        };

        let old_key = tile_render_cache_key(
            "D:/jobs/same.pdf",
            old_identity,
            1,
            1.0,
            0,
            None,
            None,
            None,
            None,
        );
        let new_key = tile_render_cache_key(
            "D:/jobs/same.pdf",
            new_identity,
            1,
            1.0,
            0,
            None,
            None,
            None,
            None,
        );

        assert_ne!(old_key, new_key);
    }
}

#[cfg(test)]
mod tile_cache_tests {
    use super::*;

    #[test]
    fn byte_budget_evicts_oldest_entries_until_the_new_tile_fits() {
        let mut cache = TileCache::new(Some(10));
        cache.insert("a".to_string(), vec![1; 4]);
        cache.insert("b".to_string(), vec![2; 4]);
        assert_eq!(cache.get("a"), Some(vec![1; 4]));

        cache.insert("c".to_string(), vec![3; 5]);

        assert!(cache.map.contains_key("a"));
        assert!(!cache.map.contains_key("b"));
        assert!(cache.map.contains_key("c"));
        assert_eq!(cache.current_bytes, 9);
    }

    #[test]
    fn oversized_tile_is_not_cached_and_replacement_updates_accounting() {
        let mut cache = TileCache::new(Some(8));
        cache.insert("a".to_string(), vec![1; 4]);
        cache.insert("a".to_string(), vec![2; 6]);
        assert_eq!(cache.current_bytes, 6);
        assert_eq!(cache.get("a"), Some(vec![2; 6]));

        cache.insert("too-large".to_string(), vec![3; 9]);

        assert!(!cache.map.contains_key("too-large"));
        assert_eq!(cache.current_bytes, 6);
    }

    #[test]
    fn tile_cache_budget_only_reduces_on_low_memory_machines() {
        assert_eq!(
            tile_cache_budget_for_total_ram(Some(4 * GIB)),
            Some(64 * MIB)
        );
        assert_eq!(
            tile_cache_budget_for_total_ram(Some(8 * GIB)),
            Some(128 * MIB)
        );
        assert_eq!(
            tile_cache_budget_for_total_ram(Some(15 * GIB)),
            Some(128 * MIB)
        );
        assert_eq!(tile_cache_budget_for_total_ram(Some(16 * GIB)), None);
        assert_eq!(tile_cache_budget_for_total_ram(Some(64 * GIB)), None);
        assert_eq!(tile_cache_budget_for_total_ram(None), None);
    }

    #[test]
    fn tile_cache_budget_override_supports_unbounded_and_rejects_invalid_values() {
        assert_eq!(
            parse_tile_cache_budget_override(Some("256")),
            Some(Some(256 * MIB))
        );
        assert_eq!(parse_tile_cache_budget_override(Some("0")), Some(None));
        assert_eq!(parse_tile_cache_budget_override(Some("invalid")), None);
        assert_eq!(parse_tile_cache_budget_override(None), None);
        assert_eq!(
            parse_tile_cache_budget_override(Some(&usize::MAX.to_string())),
            None
        );
    }
}

#[cfg(test)]
mod doc_cache_tests {
    use super::*;

    fn cached_document(identity: PdfFileIdentity) -> Arc<CachedDocument> {
        Arc::new(CachedDocument {
            pool: Vec::new(),
            user_units: vec![DEFAULT_PDF_USER_UNIT],
            page_lru_cap: PAGE_LRU_CAP_FULL,
            bootstrap_color_risk: pdf_color_risk::PdfColorRiskSummary::empty(),
            color_risk: Mutex::new(Some(pdf_color_risk::PdfColorRiskSummary::empty())),
            file_identity: identity,
            next: AtomicUsize::new(0),
        })
    }

    #[test]
    fn summary_bootstrap_khong_bi_cache_nham_thanh_metadata_day_du() {
        let identity = PdfFileIdentity {
            size: 100,
            modified_nanos: 1,
            created_nanos: Some(1),
        };
        let mut bootstrap = pdf_color_risk::PdfColorRiskSummary::empty();
        bootstrap.high_risk = true;
        bootstrap.accurate_color_recommended = true;
        bootstrap.risky_pages = vec![2];
        let document = CachedDocument {
            pool: Vec::new(),
            user_units: vec![DEFAULT_PDF_USER_UNIT; 2],
            page_lru_cap: PAGE_LRU_CAP_FULL,
            bootstrap_color_risk: bootstrap.clone(),
            color_risk: Mutex::new(None),
            file_identity: identity,
            next: AtomicUsize::new(0),
        };

        assert_eq!(document.bootstrap_color_risk, bootstrap);
        assert!(lock_mutex(&document.color_risk).is_none());
    }

    #[test]
    fn lru_evicts_oldest_but_keeps_recently_touched_entry() {
        let mut cache = DocumentCache::new(Some(2));
        assert!(cache.insert("a".to_string(), 1).is_empty());
        assert!(cache.insert("b".to_string(), 2).is_empty());
        assert_eq!(cache.get_cloned("a"), Some(1));

        let removed = cache.insert("c".to_string(), 3);

        assert_eq!(removed, vec![2]);
        assert!(cache.map.contains_key("a"));
        assert!(!cache.map.contains_key("b"));
        assert!(cache.map.contains_key("c"));
    }

    #[test]
    fn unbounded_policy_keeps_entries_until_explicit_close() {
        let mut cache = DocumentCache::new(None);
        for index in 0..32 {
            assert!(cache.insert(format!("doc-{index}"), index).is_empty());
        }
        assert_eq!(cache.map.len(), 32);
        assert_eq!(cache.remove("doc-10"), Some(10));
        assert_eq!(cache.map.len(), 31);
        assert!(!cache.order.iter().any(|key| key == "doc-10"));
    }

    #[test]
    fn same_path_with_new_file_identity_invalidates_cached_document() {
        let old_identity = PdfFileIdentity {
            size: 100,
            modified_nanos: 1,
            created_nanos: Some(1),
        };
        let new_identity = PdfFileIdentity {
            size: 200,
            modified_nanos: 2,
            created_nanos: Some(2),
        };
        let mut cache = DocumentCache::new(Some(2));
        assert!(cache
            .insert(
                "D:/jobs/same.pdf".to_string(),
                cached_document(old_identity)
            )
            .is_empty());

        let (hit, stale) =
            cached_document_for_identity(&mut cache, "D:/jobs/same.pdf", new_identity);

        assert!(hit.is_none());
        assert!(stale.is_some());
        assert!(!cache.map.contains_key("D:/jobs/same.pdf"));
    }

    #[test]
    fn cache_limit_only_reduces_on_low_memory_machines() {
        assert_eq!(doc_cache_limit_for_total_ram(Some(4 * GIB)), Some(2));
        assert_eq!(doc_cache_limit_for_total_ram(Some(8 * GIB)), Some(4));
        assert_eq!(doc_cache_limit_for_total_ram(Some(15 * GIB)), Some(4));
        assert_eq!(doc_cache_limit_for_total_ram(Some(16 * GIB)), None);
        assert_eq!(doc_cache_limit_for_total_ram(Some(64 * GIB)), None);
        assert_eq!(doc_cache_limit_for_total_ram(None), None);
    }

    #[test]
    fn page_lru_chi_giam_tren_hai_tier_ram_thap() {
        assert_eq!(page_lru_cap_for_total_ram(Some(4 * GIB)), 6);
        assert_eq!(page_lru_cap_for_total_ram(Some(8 * GIB)), 12);
        assert_eq!(page_lru_cap_for_total_ram(Some(15 * GIB)), 12);
        assert_eq!(page_lru_cap_for_total_ram(Some(16 * GIB)), 24);
        assert_eq!(page_lru_cap_for_total_ram(Some(64 * GIB)), 24);
        assert_eq!(page_lru_cap_for_total_ram(None), 24);
    }

    #[test]
    fn memory_status_serializes_with_camel_case_fields() {
        let status = SystemMemoryStatus {
            installed_bytes: 32 * GIB,
            total_bytes: 32 * GIB,
            usable_bytes: 31 * GIB,
            available_bytes: 24 * GIB,
        };

        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "installedBytes": 32 * GIB,
                "totalBytes": 32 * GIB,
                "usableBytes": 31 * GIB,
                "availableBytes": 24 * GIB,
            })
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_memory_status_reports_available_within_total() {
        let status = get_system_memory_status().unwrap();

        assert!(status.installed_bytes > 0);
        assert_eq!(status.total_bytes, status.installed_bytes);
        assert!(status.usable_bytes <= status.installed_bytes);
        assert!(status.total_bytes > 0);
        assert!(status.available_bytes <= status.usable_bytes);
        assert_eq!(system_total_memory_bytes(), Some(status.total_bytes));
    }
}

#[cfg(test)]
mod batch_folder_tests {
    use super::*;

    fn test_dir(label: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("prynx_{}_{}_{}", label, std::process::id(), stamp));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn batch_scan_filters_temp_and_unsupported_files() {
        let dir = test_dir("scan");
        let extension_oracle = [
            "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp",
        ];
        for extension in extension_oracle {
            let upper = extension.to_ascii_uppercase();
            assert!(supported_batch_extension(std::path::Path::new(&format!(
                "source.{upper}"
            ))));
            std::fs::write(dir.join(format!("source.{upper}")), b"fixture").unwrap();
        }
        std::fs::write(dir.join("~$source.DOCX"), b"lock").unwrap();
        std::fs::write(dir.join("notes.txt"), b"ignore").unwrap();

        let files = list_batch_folder_files(dir.to_string_lossy().to_string()).unwrap();
        let mut expected = extension_oracle
            .into_iter()
            .map(|extension| format!("source.{}", extension.to_ascii_uppercase()))
            .collect::<Vec<_>>();
        expected.sort_by_key(|name| name.to_ascii_lowercase());
        assert_eq!(
            files
                .iter()
                .map(|file| file.name.clone())
                .collect::<Vec<_>>(),
            expected
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sensitive_path_blocks_keys_and_secrets_everywhere() {
        // Khoá/bí mật theo tên/đuôi bị chặn ở MỌI thư mục (đối xứng deny-list
        // assetProtocol + capabilities fs:*). `.key` là guard mới (audit 2026-07-26).
        assert!(is_sensitive_path("C:\\Users\\bob\\Desktop\\server.key"));
        assert!(is_sensitive_path("D:/work/tls/private.KEY")); // hoa/thường + dấu /
        assert!(is_sensitive_path("C:\\secrets\\cert.pem"));
        assert!(is_sensitive_path("C:\\secrets\\store.pfx"));
        assert!(is_sensitive_path("C:\\proj\\.env"));
        assert!(is_sensitive_path("C:\\proj\\.env.production"));
        assert!(is_sensitive_path("C:\\proj\\credentials.json"));
        assert!(is_sensitive_path("C:\\keys\\id_rsa"));
        // Chống path traversal.
        assert!(is_sensitive_path("C:\\a\\..\\b\\x.pdf"));
        // Luồng thật KHÔNG bị đụng: PDF/ảnh/ICC/font bình thường qua được.
        assert!(!is_sensitive_path("C:\\Users\\bob\\Documents\\artwork.pdf"));
        assert!(!is_sensitive_path("D:/jobs/proof.png"));
        assert!(!is_sensitive_path("C:\\profiles\\CoatedFOGRA39.icc"));
    }

    /// SEC (audit 2026-08-28 §SEC.04): trước bản vá, mọi ca dưới đây trả `false` (lọt)
    /// vì deny-list so khớp chuỗi THÔ. Đường khai thác: `read_system_file` cho đuôi
    /// `.json` ⇒ renderer bị chèn mã đọc được `.aws\sso\cache\*.json` (bearer token).
    #[test]
    fn sensitive_path_khong_bi_di_vong_bang_bien_the_path() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() {
            return; // môi trường không có HOME: các luật theo thư mục không áp dụng
        }

        // 1. Tiền tố verbatim `\\?\` — Win32 fs::read chấp nhận, deny-list cũ thì không thấy.
        let verbatim_aws = format!("\\\\?\\{home}\\.aws\\sso\\cache\\token.json");
        assert!(is_sensitive_path(&verbatim_aws));
        // Chốt LÝ DO bản vá phải tồn tại: cách so khớp CŨ (chuỗi thô, không bóc tiền tố)
        // trả `false` cho đúng path trên. Nếu ai đó gỡ `strip_path_prefix_aliases` khỏi
        // `is_sensitive_path` thì assert bên trên đỏ, và assert này giải thích tại sao.
        assert!(
            !is_sensitive_path_text(&verbatim_aws.replace('/', "\\").to_lowercase()),
            "hành vi CŨ (so chuỗi thô) đáng lẽ để lọt — nếu nó chặn được thì test này \
             không còn chứng minh gì, phải viết lại ca kiểm"
        );
        // 2. Tiền tố NT `\??\`.
        assert!(is_sensitive_path(&format!(
            "\\??\\{home}\\.docker\\config.json"
        )));
        // 3. Tiền tố lồng nhau.
        assert!(is_sensitive_path(&format!(
            "\\\\?\\\\??\\{home}\\.ssh\\known_hosts"
        )));
        // 4. Master key DPAPI qua verbatim — đọc được là giải mã được prynx_license.dat.
        assert!(is_sensitive_path(&format!(
            "\\\\?\\{home}\\AppData\\Roaming\\Microsoft\\Protect\\x"
        )));

        // 5. Admin share trỏ về ổ cục bộ.
        assert!(is_sensitive_path(
            "\\\\localhost\\C$\\Users\\bob\\.aws\\x.json"
        ));
        assert!(is_sensitive_path("\\\\127.0.0.1\\ADMIN$\\y"));
        assert!(is_sensitive_path(
            "\\\\?\\UNC\\localhost\\C$\\Users\\bob\\.aws\\x.json"
        ));
        // 6. Device namespace.
        assert!(is_sensitive_path("\\\\.\\PhysicalDrive0"));

        // KHÔNG chặn oan share NAS hợp lệ của xưởng in (tên share không kết thúc bằng `$`).
        assert!(!is_sensitive_path("\\\\nas\\khuon\\job-2026.pdf"));
        assert!(!is_sensitive_path("\\\\server\\in-an\\proof.png"));
        // Và không chặn oan path thường có tiền tố verbatim.
        assert!(!is_sensitive_path("\\\\?\\D:\\jobs\\artwork.pdf"));
    }

    /// Junction/symlink và tên ngắn 8.3 chỉ bịt được bằng canonicalize — nhánh thứ hai
    /// của `is_sensitive_path`. Test tạo junction thật nên chỉ chạy trên Windows.
    #[cfg(windows)]
    #[test]
    fn sensitive_path_resolve_junction_ve_thu_muc_nhay_cam() {
        let home = match std::env::var("USERPROFILE") {
            Ok(value) if !value.is_empty() => value,
            _ => return,
        };
        let secret_dir = std::path::Path::new(&home).join(".aws");
        if std::fs::create_dir_all(&secret_dir).is_err() {
            return;
        }
        let secret_file = secret_dir.join("prynx-audit-probe.json");
        if std::fs::write(&secret_file, b"{}").is_err() {
            return;
        }

        let link = test_dir("junction").join("link");
        let _ = std::fs::remove_dir_all(&link);
        let created = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &secret_dir.to_string_lossy(),
            ])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);

        if created {
            // Chuỗi thô KHÔNG khớp prefix `%USERPROFILE%\.aws` — chỉ canonicalize mới thấy.
            let through_link = link.join("prynx-audit-probe.json");
            assert!(
                is_sensitive_path(&through_link.to_string_lossy()),
                "junction phải bị resolve về .aws"
            );
            let _ = std::fs::remove_dir_all(&link);
        }
        let _ = std::fs::remove_file(&secret_file);
    }

    #[test]
    fn batch_write_never_overwrites_existing_pdf() {
        let dir = test_dir("write");
        std::fs::write(dir.join("report.pdf"), b"%PDF-original").unwrap();

        let output = write_batch_pdf_for_window(
            "main",
            dir.to_string_lossy().to_string(),
            "report.pdf".to_string(),
            b"%PDF-new".to_vec(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read(dir.join("report.pdf")).unwrap(),
            b"%PDF-original"
        );
        assert!(output.ends_with("report_2.pdf"));
        assert_eq!(std::fs::read(output).unwrap(), b"%PDF-new");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn document_child_bi_chan_batch_truoc_khi_tao_file_tam() {
        // SEC (audit 2026-09-04 §SEC.15): gọi đúng helper mà command dùng để
        // chứng minh fail trước `write_batch_pdf_impl` và không rơi `.tmp`.
        let dir = test_dir("child_batch_block");
        let before = std::fs::read_dir(&dir).unwrap().count();
        let error = write_batch_pdf_for_window(
            "document-deadbeef",
            dir.to_string_lossy().to_string(),
            "report.pdf".to_string(),
            b"%PDF-new".to_vec(),
        )
        .expect_err("document-* phải bị chặn khỏi batch sink");
        assert!(error.contains("không được dùng lệnh xuất hàng loạt"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before);

        let source = dir.join("source.pdf");
        std::fs::write(&source, b"%PDF-source").unwrap();
        let before_copy = std::fs::read_dir(&dir).unwrap().count();
        assert!(copy_batch_pdf_for_window(
            "document-deadbeef",
            source.to_string_lossy().to_string(),
            dir.to_string_lossy().to_string(),
            "copy.pdf".to_string(),
        )
        .is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before_copy);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod system_file_stat_tests {
    use super::*;

    fn test_dir() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("prynx_stat_{}_{}", std::process::id(), stamp));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn native_stat_distinguishes_available_missing_and_unreachable_parent() {
        let dir = test_dir();
        let available_path = dir.join("tài-liệu.pdf");
        std::fs::write(&available_path, b"%PDF").unwrap();

        let available = stat_system_file_blocking(&available_path);
        assert_eq!(available.status, SystemFileStatStatus::Available);
        assert_eq!(available.size, 4);

        let missing = stat_system_file_blocking(&dir.join("da-xoa.pdf"));
        assert_eq!(missing.status, SystemFileStatStatus::Missing);
        assert_eq!(missing.size, 0);

        let unreachable_parent =
            stat_system_file_blocking(&dir.join("share-khong-ton-tai").join("file.pdf"));
        assert_eq!(
            unreachable_parent.status,
            SystemFileStatStatus::Inaccessible
        );

        let directory_with_pdf_suffix = dir.join("thu-muc.pdf");
        std::fs::create_dir_all(&directory_with_pdf_suffix).unwrap();
        let directory = stat_system_file_blocking(&directory_with_pdf_suffix);
        assert_eq!(directory.status, SystemFileStatStatus::Inaccessible);

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn permission_or_io_error_never_becomes_missing() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            classify_system_file_stat_error(&denied, true),
            SystemFileStatStatus::Inaccessible
        );
    }
}

#[cfg(test)]
mod perf_and_sidecar_cache_tests {
    use super::*;

    fn test_root(label: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "prynx_sidecar_cache_{}_{}_{}",
            label,
            std::process::id(),
            stamp
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn preview_perf_chi_bat_khi_opt_in_ro_rang() {
        for value in [Some("1"), Some("true"), Some("YES"), Some("on")] {
            assert!(perf_env_value_enabled(value));
            assert!(preview_perf_enabled_for_build(true, value));
            assert!(!preview_perf_enabled_for_build(false, value));
        }
        for value in [None, Some(""), Some("0"), Some("false"), Some("off")] {
            assert!(!perf_env_value_enabled(value));
            assert!(!preview_perf_enabled_for_build(true, value));
            assert!(!preview_perf_enabled_for_build(false, value));
        }
    }

    #[test]
    fn prune_chi_xoa_cache_cu_va_giu_current_cung_previous() {
        let root = test_root("keep_current");
        let base = root.join("PrynX");
        std::fs::create_dir_all(&base).unwrap();
        for name in [
            "sidecar-1.0.0.1-1.0.0.1",
            "sidecar-1.0.0.2-1.0.0.2",
            "sidecar-1.0.0.3-1.0.0.3",
            "sidecar-khong-hop-le",
        ] {
            std::fs::create_dir_all(base.join(name)).unwrap();
        }
        std::fs::write(base.join("sidecar-9.9.9.9"), b"khong-phai-thu-muc").unwrap();
        let outside = root.join("sidecar-0.0.0.1");
        std::fs::create_dir_all(&outside).unwrap();

        let (removed, failed) =
            prune_sidecar_caches(&base, Some("sidecar-1.0.0.3-1.0.0.3")).unwrap();

        assert_eq!(removed, vec!["sidecar-1.0.0.1-1.0.0.1"]);
        assert!(failed.is_empty());
        assert!(base.join("sidecar-1.0.0.3-1.0.0.3").is_dir());
        assert!(base.join("sidecar-1.0.0.2-1.0.0.2").is_dir());
        assert!(base.join("sidecar-khong-hop-le").is_dir());
        assert!(base.join("sidecar-9.9.9.9").is_file());
        assert!(outside.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn temporary_mode_xoa_toan_bo_cache_persistent_cu() {
        let root = test_root("unknown_current");
        let base = root.join("PrynX");
        for name in [
            "sidecar-1.0.0.1-1.0.0.1",
            "sidecar-1.0.0.2-1.0.0.2",
            "sidecar-1.0.0.3-1.0.0.3",
        ] {
            std::fs::create_dir_all(base.join(name)).unwrap();
        }

        let (removed, failed) = prune_sidecar_caches(&base, None).unwrap();

        assert_eq!(
            removed,
            vec![
                "sidecar-1.0.0.3-1.0.0.3",
                "sidecar-1.0.0.2-1.0.0.2",
                "sidecar-1.0.0.1-1.0.0.1"
            ]
        );
        assert!(failed.is_empty());
        assert!(!base.join("sidecar-1.0.0.3-1.0.0.3").exists());
        assert!(!base.join("sidecar-1.0.0.2-1.0.0.2").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic hook: release chỉ ghi marker tổng quát. Message/vị trí có thể lộ
    // tên engine, path hoặc dữ liệu exception (SEC audit 2026-09-05 §LOG.04).
    std::panic::set_hook(Box::new(|info| {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let dir = std::path::Path::new(&appdata).join("PrynX").join("logs");
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("rust_panic.log"))
            {
                use std::io::Write;
                let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                if cfg!(debug_assertions) {
                    let _ = writeln!(f, "[{}] PANIC: {} | at {:?}", now, info, info.location());
                } else {
                    let _ = writeln!(f, "[{}] PANIC: lỗi nội bộ; chi tiết đã được ẩn", now);
                }
            }
        }
    }));
    // ─── FIX "chỉ nhanh khi mở DevTools": WebView2 trên cửa sổ transparent hay tính
    // NHẦM là bị che (occluded) → bóp ga (throttle) timer + render xuống cực chậm
    // (load file ~7s). Mở DevTools ép cửa sổ "active" nên hết throttle → nhanh tức thì.
    // Tắt occlusion + background/timer throttling NGAY TRƯỚC khi WebView2 environment
    // được tạo (env var phải set sớm; config additionalBrowserArgs không đủ tin cậy).
    #[cfg(target_os = "windows")]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        // CHỈ thêm các cờ AN TOÀN (không mở remote-debugging-port) — không tạo lỗ hổng.
        // COLOR (feedback 2026-08-10 §VIEWER.C2): bitmap PPE đã là sRGB. Ép display
        // surface về sRGB để WebView2 không đổi lần hai qua ICC màn hình rồi làm màu
        // Viewer khác Acrobat trên cùng máy. Cờ này không đổi dữ liệu PDF/soft-proof.
        let flags = "--force-color-profile=srgb --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding";
        let merged = if existing.trim().is_empty() {
            flags.to_string()
        } else {
            format!("{} {}", existing, flags)
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }

    startup_breadcrumb("process entry — creating windows");

    // [PROC-LIFECYCLE FIX 2026-08-28 §UP.6] Phải chạy TRƯỚC Builder: plugin single-instance
    // quyết định exit(0) ngay trong setup của nó, nên đây là chỗ duy nhất còn kịp đánh dấu
    // "ta là instance thứ hai".
    claim_primary_instance_mutex();

    tauri::Builder::default()
        .manage(SystemFilesState::new(std::env::args().collect()))
        // UIUX/SEC (audit 2026-08-25 §NW.3/§NW.8): bootstrap cửa sổ PDF chỉ sống
        // trong RAM native và được lấy đúng một lần theo label của chính WebView.
        .manage(Mutex::new(document_window_registry::DocumentWindowRegistry::default()))
        // SEC (audit 2026-08-04 §BE.03): không expose command nghiệp vụ không có
        // consumer/quyền native. Mọi bình bản và xóa đường bế đi qua sidecar đã gate.
        .invoke_handler(tauri::generate_handler![render_pdf_page, render_ppe_page, shadow_render_ppe_page, release_ppe_session_owner, cancel_pdf_render, get_pdf_viewer_bootstrap, get_pdf_metadata, close_pdf_document, get_system_memory_status, get_current_display_metrics, take_startup_system_file_batch, get_startup_args, mark_frontend_interactive, prepare_for_update, read_system_file, get_file_size, stat_system_file, list_batch_folder_files, write_batch_pdf, copy_batch_pdf, take_pending_system_file_batches, get_pending_system_files, write_file_atomic, copy_file_atomic, delete_file_scoped, read_dir_json, preview_perf_logging_enabled, append_render_perf, log_frontend_error, grant_upscale_file_path, document_window_registry::create_document_window, document_window_registry::take_document_window_bootstrap, document_window_registry::show_document_window_ready, document_window_registry::request_document_save_grant, pdf_engine::print::print_pdf, pdf_engine::print::print_pdf_direct, pdf_engine::print::cancel_print_job, pdf_engine::print::open_printer_properties, pdf_engine::print::list_printers, pdf_engine::print::get_printer_geometry, pdf_engine::print::delete_print_temp, pdf_engine::print::log_print_event, device_identity::get_device_public_identity, device_identity::sign_device_license_challenge, security::get_hardware_id, security::store_license, security::load_license, security::delete_license, security::begin_license_validation, security::register_validated_key, security::clear_validated_keys, security::sign_api_request, security::store_last_online, security::load_last_online, security::load_clock_anchor, security::store_license_token, security::load_license_token, security::delete_license_token, normalize_image_to_png, normalize_image_bytes, external_app::detect_design_apps, external_app::launch_external_app])
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(state) = app.try_state::<SystemFilesState>() {
                state.enqueue(args);
            }

            if APP_STARTUP_READY.load(Ordering::Acquire) {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.unminimize() {
                        log::warn!("[WINDOW] Không khôi phục được cửa sổ từ lần mở thứ hai: {}", error);
                    }
                    if let Err(error) = window.show() {
                        log::warn!("[WINDOW] Không hiện được cửa sổ từ lần mở thứ hai: {}", error);
                    }
                    let _ = window.set_always_on_top(true);
                    let _ = window.set_always_on_top(false);
                    if let Err(error) = window.set_focus() {
                        log::warn!("[WINDOW] Không focus được cửa sổ từ lần mở thứ hai: {}", error);
                    }
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                document_window_registry::handle_window_destroyed(window.app_handle(), window.label());
            }
            if window.label() != "main" || !APP_STARTUP_READY.load(Ordering::Acquire) {
                return;
            }

            // UIUX (feedback 2026-08-11 §WINDOW.RESTORE): trên cửa sổ frameless,
            // Windows đôi khi phát focus từ taskbar trong khi HWND vẫn Iconic.
            // Khôi phục ngay tại biên native; không auto-restore khi user chủ động
            // minimize vì nhánh này chỉ chạy khi cửa sổ thực sự nhận focus lại.
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                match window.is_minimized() {
                    Ok(true) => {
                        startup_breadcrumb("window: focused while minimized — restoring");
                        if let Err(error) = window.unminimize() {
                            log::warn!("[WINDOW] Không unminimize được khi nhận focus: {}", error);
                        }
                        if let Err(error) = window.show() {
                            log::warn!("[WINDOW] Không show được khi nhận focus: {}", error);
                        }
                    }
                    Ok(false) => {}
                    Err(error) => {
                        log::warn!("[WINDOW] Không đọc được trạng thái minimized: {}", error);
                    }
                }
            }
        })
        .setup(|app| {
            // SEC/DATA (audit 2026-08-25 §NW.8): dọn snapshot cửa sổ tài liệu
            // còn sót từ lần chạy bị crash; file đang sống được registry giữ riêng.
            document_window_registry::schedule_startup_cleanup(app.handle().clone());
            if let Some(startup_window) = app.get_webview_window("startup") {
                #[cfg(debug_assertions)]
                {
                    // Dev không chờ Nuitka sidecar; đóng ngay để tránh flash thừa.
                    let _ = startup_window.close();
                }
                #[cfg(not(debug_assertions))]
                {
                    // PERF (audit 2026-08-05 §PERF.5): cửa sổ startup được tạo ẩn
                    // để không vẽ frame trước setup. Worker release sẽ xếp lịch show
                    // từ thread nền, sau khi event loop có thể nhận task.
                    let _ = startup_window;
                    startup_breadcrumb("native splash: created (hidden; show queued from worker)");
                }
            }

            // Log LUÔN được bật — kể cả release. Trước đây guard `cfg!(debug_assertions)`
            // khiến bản đóng gói KHÔNG ghi log gì → mọi `log::error!` (pdfium warmup FAIL,
            // sidecar spawn fail, render lỗi) rơi vào hư không → không thể chẩn đoán lỗi
            // "máy khách xem preview trắng". Ghi ra file trong LogDir (mở lại/gửi được).
            {
                let level = if cfg!(debug_assertions) {
                    log::LevelFilter::Info
                } else {
                    // Release: ghi từ Warn trở lên để bắt lỗi mà không phình file log.
                    log::LevelFilter::Warn
                };
                let mut builder = tauri_plugin_log::Builder::default().level(level);
                if !cfg!(debug_assertions) {
                    // Release: CHỈ ghi file (không có Stdout vì console bị ẩn; không có
                    // Webview vì devtools bị tắt). File nằm trong thư mục log của app —
                    // %LOCALAPPDATA%\com.prynx.app\logs\PrynX.log (hoặc tương đương).
                    builder = builder
                        .clear_targets()
                        .target(tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::LogDir {
                                file_name: Some("PrynX".into()),
                            },
                        ));
                }
                app.handle().plugin(builder.build())?;
            }

            // Đường log đo render chỉ mở ở binary dev + PRYNX_PERF=1; việc đăng
            // ký đường dẫn không tạo file và release không có đường bật lại.
            if let Ok(desktop_dir) = app.handle().path().desktop_dir() {
                let _ = PERF_LOG_PATH.set(desktop_dir.join("PrynX_RenderPerf.log"));
            }

            // ══════════════════════════════════════════════════════════════
            // VECTOR #9 FIX: Kill WebView2 debug env vars BEFORE anything
            // Hacker can set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS to open
            // remote debugging port, bypassing SetAreDevToolsEnabled(false).
            // ══════════════════════════════════════════════════════════════
            #[cfg(not(debug_assertions))]
            {
                std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
                std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
                std::env::remove_var("WEBVIEW2_USER_DATA_FOLDER");
                // Also block common debugger env vars
                std::env::remove_var("NODE_OPTIONS");
                std::env::remove_var("ELECTRON_RUN_AS_NODE");
            }

            // ══════════════════════════════════════════════════════════════
            // VECTOR #15: process mitigations — TẮT trên bản release hiện tại.
            //
            // Lịch sử: MicrosoftSignedOnly + ProhibitDynamicCode chỉ chạy
            // #[cfg(not(debug_assertions))] → dev in OK, release Ctrl+P process
            // chết (không rust_panic.log — AV/SEH từ driver máy in hoặc chặn
            // LoadLibrary/code gen). Print GDI (EnumPrinters/CreateDC/PrintDlg/
            // FPDF_RenderPage→HDC) nạp driver third-party + đôi khi cấp exec mem.
            // Không thể vừa chặn DLL lạ tuyệt đối vừa in native in-process.
            // PDFium warm trong display worker khi mode bật; anti-debug chỉ GHI LOG.
            // ══════════════════════════════════════════════════════════════
            #[cfg(not(debug_assertions))]
            {
                startup_breadcrumb("release setup: begin");

                // [PROC-LIFECYCLE FIX 2026-08-28 §UP.6] Tới được đây với cờ instance thứ hai
                // nghĩa là plugin single-instance KHÔNG forward được sang instance kia (không
                // tìm thấy cửa sổ ẩn của nó) và cũng không exit ta. Chạy tiếp thì cold-start
                // bên dưới sẽ taskkill sidecar của instance kia và giành cổng 8321 — biến một
                // app đang treo thành hai app đều hỏng. Dừng tại đây và nói rõ cách sửa.
                if SECONDARY_INSTANCE.load(Ordering::Acquire) {
                    startup_breadcrumb(
                        "instance guard: another PrynX process is alive but not responding — refusing to start",
                    );
                    log::error!(
                        "[INSTANCE] Từ chối khởi động instance thứ hai: instance đang chạy không phản hồi."
                    );
                    show_startup_error_dialog(&[
                        "PrynX dang chay nhung khong phan hoi nen khong the mo cua so moi.",
                        "CACH SUA: mo Task Manager, ket thuc tien trinh pdf-inspector.exe (va pdf-inspector-backend.exe neu con) roi mo lai PrynX.",
                        "Chi tiet ky thuat: %APPDATA%\\PrynX\\logs\\startup_debug.log",
                    ]);
                    std::process::exit(1);
                }

                let warm_result = match pdf_engine::render_worker::warm_worker_with_policy() {
                    Ok(pdf_engine::render_worker::WorkerAttempt::Completed(())) => {
                        Ok("worker")
                    }
                    Ok(pdf_engine::render_worker::WorkerAttempt::Disabled) => {
                        ensure_pdfium().map(|_| "in-process")
                    }
                    Ok(pdf_engine::render_worker::WorkerAttempt::FallbackBeforeStart(reason)) => {
                        log::warn!("[RENDER_WORKER] startup fallback: {}", reason);
                        ensure_pdfium().map(|_| "in-process-fallback")
                    }
                    Err(error) => Err(error),
                };
                match warm_result {
                    Ok(location) => {
                        log::info!("[SECURITY] pdfium warmed up at startup ({})", location);
                        startup_breadcrumb(&format!("pdfium: OK {location}"));
                    }
                    Err(e) => {
                        log::error!("[SECURITY] pdfium warmup FAILED: {}", e);
                        startup_breadcrumb(&format!("pdfium: FAIL {e}"));
                    }
                }

                // Mitigations OPT-IN sau khi pdfium đã nạp (audit 2026-07-25). Mặc định
                // TẮT → hành vi bản release không đổi. Đặt PRYNX_MITIGATIONS=1 để QA thử
                // trên BẢN ĐÃ CÀI, đặc biệt phải test kỹ đường IN (Ctrl+P) vì đó chính là
                // chỗ từng làm process chết khi bật MicrosoftSignedOnly.
                security::apply_optional_process_mitigations();

                // Chỉ log, KHÔNG exit — tránh false-positive giết app khi user in.
                security::start_anti_debug_monitor();
                startup_breadcrumb("anti-debug: log-only monitor started");
            }

            // VECTOR #4 FIX: Verify frontend JS hasn't been tampered with
            #[cfg(not(debug_assertions))]
            {
                match verify_frontend_integrity(app) {
                    Ok(()) => startup_breadcrumb("frontend integrity: OK (or skipped — embedded)"),
                    Err(e) => {
                    log::error!("[SECURITY] {}", e);
                    startup_breadcrumb(&format!("frontend integrity: FAIL {e}"));
                    // Show error dialog and exit. Escape ' — `e` có thể chứa tên file (từ
                    // sha256_directory: "Cannot open {path}: {e}") mà kẻ nghịch dist/ đặt tên
                    // chứa dấu nháy để thoát khỏi chuỗi PS single-quote → chèn lệnh. Escape
                    // như 2 dialog sidecar bên dưới.
                    show_startup_error_dialog(&[e.as_str()]);
                    std::process::exit(1);
                    }
                }
            }

            // SEC (audit 2026-09-03 §SEC.19-R1): master CSPRNG sống suốt vòng đời
            // Tauri nhưng không ký API trực tiếp. Mỗi generation derive một session key.
            let generate_sidecar_master_token = || {
                use rand::RngCore;
                let mut bytes = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut bytes);
                hex::encode(bytes)
            };
            #[cfg(debug_assertions)]
            let sidecar_master_token: String = std::env::var("PRYNX_SIDECAR_TOKEN")
                .ok()
                .filter(|token| token.len() >= 32)
                .unwrap_or_else(generate_sidecar_master_token);
            #[cfg(not(debug_assertions))]
            let sidecar_master_token: String = generate_sidecar_master_token();

            #[cfg(all(not(debug_assertions), target_os = "windows"))]
            if SIDECAR_MASTER_TOKEN
                .set(sidecar_master_token.clone())
                .is_err()
            {
                log::error!("[SIDECAR] Master authority đã được khởi tạo ngoài dự kiến");
                std::process::exit(1);
            }

            // Dev/fixture chạy backend riêng vẫn dùng protocol token đơn. Release Windows
            // chỉ publish session sau startup proof nên request trong lúc restart fail-closed.
            #[cfg(not(all(not(debug_assertions), target_os = "windows")))]
            security::set_sidecar_token(&sidecar_master_token);

            // ══════════════════════════════════════════════════════════════
            // VECTOR #6 FIX: Pass bootstrap authority via stdin pipe (NOT file).
            // Secret NEVER touches disk — zero race condition window.
            // Old method (temp file) could be intercepted by Process Monitor.
            // ══════════════════════════════════════════════════════════════
            #[cfg(not(debug_assertions))]
            {
                // PERF (audit 2026-08-05 §PERF.5): hash 413 MB + cold-start Nuitka
                // có thể mất hàng chục giây. Chạy ngoài UI thread để event loop paint
                // splash ngay và không bị Windows gắn "Not Responding".
                let app = app.handle().clone();
                std::thread::Builder::new()
                    .name("prynx-release-startup".to_string())
                    .spawn(move || {
                        // UIUX (startup flash): gửi show từ thread nền để Tauri
                        // xếp task vào event loop; gọi từ setup/main thread sẽ chạy ngay.
                        let splash_handle = app.clone();
                        if let Err(error) = app.run_on_main_thread(move || {
                            if APP_STARTUP_READY.load(Ordering::Acquire) {
                                return;
                            }
                            if let Some(startup_window) =
                                splash_handle.get_webview_window("startup")
                            {
                                if let Err(error) = startup_window.show() {
                                    log::warn!(
                                        "[STARTUP] Không hiện được splash native: {}",
                                        error
                                    );
                                } else {
                                    startup_breadcrumb("native splash: shown");
                                }
                            } else {
                                startup_breadcrumb("native splash: missing");
                            }
                        }) {
                            startup_breadcrumb(&format!("native splash: queue FAIL {error}"));
                        }
                use tauri_plugin_shell::ShellExt;

                // VECTOR #3 FIX: verify tính toàn vẹn binary sidecar TRƯỚC khi chạy.
                // FAIL-CLOSED: không phân giải được path exe (current_exe lỗi / không có parent)
                // = từ chối chạy, KHÔNG spawn sidecar chưa verify. Trên máy thật current_exe()
                // (GetModuleFileNameW) gần như không bao giờ lỗi cho tiến trình đang chạy; nếu lỗi
                // nghĩa là process đã hỏng nặng. Trước đây 2 lớp `if let` là cửa thoát im lặng:
                // path lỗi → bỏ qua verify → spawn thẳng. Bịt nốt cửa này.
                let sidecar_path = match std::env::current_exe()
                    .map_err(|e| format!("Cannot resolve exe path: {}", e))
                    .and_then(|exe| {
                        exe.parent()
                            .map(|dir| dir.join("pdf-inspector-backend.exe"))
                            .ok_or_else(|| "Exe path has no parent directory".to_string())
                    }) {
                    Ok(p) => p,
                    Err(e) => {
                        log::error!("[SECURITY] {}", e);
                        let message = format!(
                            "Khong xac dinh duoc duong dan ung dung ({}). Vui long cai dat lai.",
                            e
                        );
                        show_startup_error_dialog(&[message.as_str()]);
                        std::process::exit(1);
                    }
                };
                if let Err(e) = verify_sidecar_integrity(&sidecar_path) {
                    log::error!("[SECURITY] {}", e);
                    startup_breadcrumb(&format!("sidecar integrity: FAIL {e}"));
                    // [PROC-LIFECYCLE FIX 2026-08-28 §UP.5] Chốt fail-closed GIỮ NGUYÊN, chỉ
                    // đổi thông điệp. Nguyên nhân thực tế phổ biến nhất của nhánh này KHÔNG
                    // phải bị crack mà là bản cập nhật đứt giữa: NSIS ghi được exe mới rồi
                    // trượt pdf-inspector-backend.exe (file đang bị chiếm) → cặp exe/sidecar
                    // lệch hash → app từ chối khởi động mãi mãi. Thông điệp cũ chỉ nói
                    // "integrity check failed" nên chủ máy hiểu là phải gỡ cài + cài lại;
                    // thực ra chỉ cần chạy lại trình cài. Chi tiết kỹ thuật đã vào log +
                    // breadcrumb, không dán vào hộp thoại.
                    show_startup_error_dialog(&[
                        "Tien trinh nen cua PrynX khong khop voi ban dang cai.",
                        "Nguyen nhan thuong gap: lan cap nhat truoc bi dut giua duong - trinh cai khong ghi duoc file vi con tien trinh dang chay.",
                        "CACH SUA: chay lai trinh cai dat ban moi nhat (PrynX_...-setup.exe). KHONG can go cai dat, du lieu va license van giu nguyen.",
                        "Neu van loi: mo Task Manager, ket thuc pdf-inspector.exe va pdf-inspector-backend.exe roi chay lai trinh cai.",
                        "Chi tiet ky thuat: %APPDATA%\\PrynX\\logs\\startup_debug.log",
                    ]);
                    std::process::exit(1);
                }
                startup_breadcrumb("sidecar integrity: OK");

                let sidecar = match app.shell().sidecar("pdf-inspector-backend") {
                    Ok(s) => s,
                    Err(e) => {
                        log::error!("[SIDECAR] Khong tim thay binary sidecar: {}", e);
                        startup_breadcrumb(&format!("sidecar binary: MISSING {e}"));
                        show_startup_error_dialog(&[
                            "Khong tim thay tien trinh nen (pdf-inspector-backend.exe). Co the bi phan mem diet virus cach ly hoac thieu file. Vui long khoi phuc/loai tru file roi mo lai ung dung.",
                        ]);
                        std::process::exit(1);
                    }
                };
                let sidecar_storage = match app
                    .path()
                    .app_local_data_dir()
                    .map_err(|error| format!("Không xác định được thư mục dữ liệu PrynX: {error}"))
                    .and_then(|dir| prepare_sidecar_storage(&dir))
                {
                    Ok(storage) => storage,
                    Err(error) => {
                        log::error!("[SIDECAR] {}", error);
                        startup_breadcrumb(&format!("sidecar storage: FAIL {error}"));
                        show_startup_error_dialog(&[error.as_str()]);
                        std::process::exit(1);
                    }
                };
                startup_breadcrumb(&format!(
                    "sidecar storage: {}",
                    sidecar_storage.working_dir.display()
                ));
                // SEC (audit 2026-09-03 §SEC.22): không được tự ý `taskkill /IM` theo tên.
                // Một listener cùng tên có thể là sidecar của instance khác hoặc process
                // cục bộ do người dùng/AV khởi chạy; giết theo image name vừa gây DoS
                // xuyên instance vừa không chứng minh được quyền sở hữu. Job Object +
                // shutdown HMAC ở đường sống bình thường đã dọn process của chính app;
                // sau crash, fail-closed và yêu cầu người dùng xử lý listener còn lại là
                // lựa chọn an toàn hơn việc liên lụy tiến trình không xác thực.
                // Chờ port free: bind test là cách kiểm tin cậy nhất ("có ai đang
                // LISTEN?"). Bind OK → drop ngay (nhả port) → spawn.
                //
                // [PROC-LIFECYCLE FIX 2026-08-28 §UP.8] Trần cũ là 1 s (20×50 ms). Sau một
                // taskkill /F, Windows còn giữ socket ở TIME_WAIT/đang tear-down một nhịp;
                // 1 s là sát quá và đường ra của nhánh này là exit(1) — tức là brick oan.
                // Nâng lên 3 s (60×50 ms): vẫn nhanh với mắt người, mà bớt hẳn ca hụt.
                let mut port_is_free = false;
                for _ in 0..60 {
                    match std::net::TcpListener::bind(("127.0.0.1", 8321u16)) {
                        Ok(listener) => {
                            drop(listener);
                            port_is_free = true;
                            break;
                        }
                        Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
                    }
                }
                if !port_is_free {
                    log::error!("[SIDECAR] Port 8321 remains occupied; refusing to contact an unknown listener.");
                    // [PROC-LIFECYCLE FIX 2026-08-28 §UP.8] Nhánh này trước đây KHÔNG ghi
                    // breadcrumb nào — mà nó lại là một trong hai đường "app không mở lên
                    // được" hay gặp nhất. Hệ quả: startup_debug.log của máy khách chỉ có
                    // "process entry" rồi im lặng, không cách nào phân biệt với các nguyên
                    // nhân khác. Ghi breadcrumb TRƯỚC khi exit.
                    startup_breadcrumb("sidecar port 8321: OCCUPIED after 3s — refusing to start");
                    show_startup_error_dialog(&[
                        "Cong noi bo 8321 dang bi chiem nen PrynX tu choi khoi dong de bao ve du lieu.",
                        "CACH SUA: mo Task Manager, ket thuc tien trinh pdf-inspector-backend.exe (va pdf-inspector.exe neu con) roi mo lai PrynX.",
                        "Neu van loi, khoi dong lai may.",
                        "Chi tiet ky thuat: %APPDATA%\\PrynX\\logs\\startup_debug.log",
                    ]);
                    std::process::exit(1);
                }

                let (sidecar_identity, sidecar_exited, sidecar_session_token) = {
                    // Đồng bộ với RunEvent::Exit/prepare_for_update để background startup
                    // không spawn sidecar sau khi đường shutdown vừa thấy PID=0.
                    let _lifecycle_guard = sidecar_lifecycle_guard();
                    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                        return;
                    }
                    let spawn_result = sidecar
                        .env_clear()
                        .envs(filtered_sidecar_environment())
                        .current_dir(&sidecar_storage.working_dir)
                        .env("UPLOAD_DIR", &sidecar_storage.upload_dir)
                        .env("RESULTS_DIR", &sidecar_storage.results_dir)
                        .args(["--port", "8321"])
                        .envs([
                            ("DEV_MODE", "false"),
                            // Signal sidecar to read token from stdin instead of file
                            ("PRYNX_TOKEN_SOURCE", "stdin"),
                            // PERF (audit 2026-08-05 §PERF.3): frontend và sidecar dùng
                            // cùng một cờ; mặc định release là 0 nên không có beacon/I/O.
                            ("PRYNX_PERF", if preview_perf_enabled() { "1" } else { "0" }),
                            // Cưỡng chế token license server-ký: backend từ chối mọi request
                            // không kèm token Ed25519 hợp lệ (do edge function Supabase phát).
                            // Client bị crack không giả được token → không gọi được backend.
                            ("PRYNX_ENFORCE_LICENSE_TOKEN", "true"),
                            // Dev thường mặc định tắt; build release nung flag true và fallback
                            // release cũng là true. Token thiếu/sai plan đã fail-closed về Free.
                            (
                                "PRYNX_FEATURE_GATING_ENABLED",
                                option_env!("PRYNX_FEATURE_GATING_ENABLED").unwrap_or(
                                    if cfg!(debug_assertions) { "false" } else { "true" }
                                ),
                            ),
                            // LOGO-REBUILD (audit 2026-08-09 §LR3.10): nung cùng cờ
                            // frontend vào host; host ghi đè env kế thừa khi spawn sidecar.
                            (
                                "PRYNX_LOGO_REBUILD_ENABLED",
                                option_env!("PRYNX_LOGO_REBUILD_ENABLED").unwrap_or("false"),
                            ),
                            // Cận chống-lùi-giờ PHẢI ≥ TTL token edge function cấp.
                            // Set qua env để override default compiled cũ mà KHÔNG cần recompile Nuitka.
                            // TTL server đã rút 7 ngày → 72h (audit 2026-07-25); cận GIỮ 8 ngày
                            // (691200s) trong giai đoạn chuyển tiếp vì token 7 ngày cũ còn hạn.
                            // Sau khi chúng hết hạn (≥7 ngày kể từ deploy), hạ xuống "345600" (4 ngày).
                            ("PRYNX_MAX_TOKEN_LIFETIME_SECONDS", "691200"),
                        ])
                        .spawn();
                    let (rx, mut child) = match spawn_result {
                        Ok(v) => v,
                        Err(e) => {
                            log::error!("[SIDECAR] Spawn that bai: {}", e);
                            show_startup_error_dialog(&[
                                "Khong khoi dong duoc tien trinh nen. Vui long mo lai ung dung; neu van loi hay lien he ho tro.",
                            ]);
                            std::process::exit(1);
                        }
                    };

                    // Forward stdout/stderr/kết-thúc của sidecar vào log Rust. Trước đây
                    // _rx bị VỨT → sidecar chết câm (vd bind 8321 thất bại) không để lại
                    // dấu vết → sự cố "invalid sidecar token" khó điều tra suốt thời gian
                    // dài. Nay log Terminated{code} → bắt được "exit 48 = port bận" tức
                    // thì. Đọc rx còn tránh đầy buffer pipe làm sidecar block. Fire-and-forget.
                    let sidecar_pid = child.pid();
                    let sidecar_identity = match register_spawned_sidecar(sidecar_pid) {
                        Ok(identity) => identity,
                        Err(error) => {
                            log::error!(
                                "[SIDECAR] Không bind được identity PID={sidecar_pid}: {error}"
                            );
                            let _ = child.kill();
                            std::process::exit(1);
                        }
                    };
                    let (bootstrap_record, sidecar_session_token) =
                        match sidecar_bootstrap_protocol_v2(
                            &sidecar_master_token,
                            sidecar_identity,
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                log::error!("[SIDECAR] Không derive được khóa phiên: {error}");
                                kill_sidecar(sidecar_identity);
                                std::process::exit(1);
                            }
                        };
                    let sidecar_exited = Arc::new(AtomicBool::new(false));
                    start_sidecar_event_reader(
                        rx,
                        Arc::clone(&sidecar_exited),
                        sidecar_identity,
                    );

                    // Lưu PID để KILL cả cây tiến trình khi thoát app (chống treo ngầm →
                    // update NSIS không ghi đè được file). Supervisor cập nhật PID mỗi thế hệ.
                    // Protocol v2 truyền master + generation qua stdin; backend tự derive
                    // session. Record chỉ sống trong RAM và không được ghi vào log.
                    if let Err(e) = child.write(bootstrap_record.as_bytes()) {
                        log::error!("[SIDECAR] Ghi token vao stdin that bai: {}", e);
                        kill_sidecar(sidecar_identity);
                        std::process::exit(1);
                    }
                    (sidecar_identity, sidecar_exited, sidecar_session_token)
                };
                if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                    return;
                }
                startup_breadcrumb(&format!(
                    "sidecar startup proof: waiting (timeout={}s)",
                    SIDECAR_STARTUP_TIMEOUT.as_secs()
                ));
                if let Err(e) =
                    verify_sidecar_startup(&sidecar_session_token, sidecar_exited.as_ref())
                {
                    log::error!("[SIDECAR] Startup identity check failed: {}", e);
                    startup_breadcrumb(&format!("sidecar startup proof: FAIL {e}"));
                    kill_sidecar(sidecar_identity);
                    show_startup_error_dialog(&[
                        "Tien trinh nen khong xac thuc duoc. PrynX da dung khoi dong de bao ve du lieu.",
                    ]);
                    std::process::exit(1);
                }
                if let Err(e) = publish_verified_sidecar_session(
                    sidecar_identity,
                    &sidecar_session_token,
                    sidecar_exited.as_ref(),
                ) {
                    if SIDECAR_SHUTDOWN.load(Ordering::Acquire) {
                        return;
                    }
                    log::error!("[SIDECAR] Không publish được khóa phiên: {e}");
                    startup_breadcrumb("sidecar startup proof: session publish failed");
                    kill_sidecar(sidecar_identity);
                    std::process::exit(1);
                }

                log::info!(
                    "Python backend sidecar started on port 8321 (session via stdin protocol v2)"
                );
                startup_breadcrumb("sidecar: ready (startup proof OK)");

                // SEC (audit 2026-09-02 §SEC.18): chỉ dọn cache persistent cũ và
                // extraction temporary của thế hệ đã chết SAU khi sidecar mới xác thực.
                // PID hiện tại được giữ; path/reparse bất thường bị bỏ qua fail-safe.
                start_sidecar_cache_cleanup(sidecar_identity.pid);

                if let Err(error) = reveal_main_window(&app) {
                    log::error!("[STARTUP] {}", error);
                    startup_breadcrumb(&format!("setup complete: FAIL {error}"));
                    kill_sidecar(sidecar_identity);
                    std::process::exit(1);
                }
                start_sidecar_supervisor(
                    app.clone(),
                    sidecar_storage.clone(),
                    sidecar_master_token.clone(),
                    Arc::clone(&sidecar_exited),
                );
                    })
                    .map_err(|error| {
                        std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("Không tạo được luồng khởi động PrynX: {error}"),
                        )
                    })?;
            }

            // ══════════════════════════════════════════════════════════════
            // VECTOR #3 FIX: Disable DevTools + context menu in release builds.
            // Prevents hacker from injecting JS via remote debugging port.
            // ══════════════════════════════════════════════════════════════
            #[cfg(not(debug_assertions))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        #[cfg(target_os = "windows")]
                        unsafe {
                            let _ = webview.controller().SetIsVisible(true);
                            if let Ok(core) = webview.controller().CoreWebView2() {
                                if let Ok(settings) = core.Settings() {
                                    let _ = settings.SetAreDevToolsEnabled(false);
                                    let _ = settings.SetAreDefaultContextMenusEnabled(false);
                                    let _ = settings.SetIsStatusBarEnabled(false);
                                }
                            }
                        }
                    });
                }
            }

            // Tắt phím tắt trình duyệt của WebView2 (Ctrl+P, Ctrl+F, F5, Ctrl+R…).
            // KHÔNG gate theo release: WebView2 bắt Ctrl+P ở tầng runtime Edge TRƯỚC khi
            // JS thấy event, nên e.preventDefault() trong React vô hiệu → Edge tự bung hộp
            // thoại "This app doesn't support print preview". Tắt accelerator keys ở đây
            // để Ctrl+P chỉ chạy handler của ta (in native qua print_pdf). Chạy cả debug
            // lẫn release để dev test đúng hành vi. Cần ICoreWebView2Settings3.
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                        use windows::core::Interface;
                        unsafe {
                            if let Ok(core) = webview.controller().CoreWebView2() {
                                if let Ok(settings) = core.Settings() {
                                    if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                        let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                                    }
                                }
                            }
                        }
                    });
                }
            }

            // Dev không có worker sidecar nên công bố main ngay. Release chỉ làm
            // việc này trong worker sau khi integrity + startup proof đã đạt.
            #[cfg(debug_assertions)]
            reveal_main_window(app.handle()).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::Other, error)
            })?;

            // SEC (audit 2026-09-04 §SEC.18/§SEC.22): plugin updater sẽ clear
            // app resource table trong on_before_exit, ngay trước ShellExecute.
            // Giữ resource không lộ RID cho renderer để chốt native không bị đóng sớm.
            #[cfg(all(not(debug_assertions), target_os = "windows"))]
            let _ = app.resources_table().add(UpdateExitCleanupResource);

            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("localfile", |_ctx, request, responder| {
            // FILEIO (audit 2026-07-28 §FL.01-§FL.04): protocol đọc file có Range,
            // không phụ thuộc asset scope và không chuyển file lớn qua IPC.
            let url = request.uri().to_string();
            let method = request.method().as_str().to_string();
            let range_header = request
                .headers()
                .get("range")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);

            tauri::async_runtime::spawn(async move {
                let result = tauri::async_runtime::spawn_blocking(move || {
                    if method.eq_ignore_ascii_case("OPTIONS") {
                        return http::Response::builder()
                            .status(204)
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                            .header("Access-Control-Allow-Headers", "Range")
                            .body(Vec::new())
                            .map_err(|e| e.to_string());
                    }

                    let mut encoded_path = url.as_str();
                    for prefix in [
                        "http://localfile.localhost/",
                        "https://localfile.localhost/",
                        "localfile://localhost/",
                        "localfile://",
                    ] {
                        if encoded_path.starts_with(prefix) {
                            encoded_path = &encoded_path[prefix.len()..];
                            break;
                        }
                    }
                    let encoded_path = encoded_path.split('?').next().unwrap_or(encoded_path);
                    let file_path = urlencoding::decode(encoded_path)
                        .map_err(|_| "Đường dẫn file không hợp lệ".to_string())?
                        .to_string();

                    let ext = std::path::Path::new(&file_path)
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let allowed = [
                        "pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "icc", "icm",
                        "svg", "ttf", "otf", "ttc", "doc", "docx", "odt", "rtf", "xls", "xlsx",
                        "ods", "csv", "ppt", "pptx", "odp", "json", "txt",
                    ];
                    if !allowed.contains(&ext.as_str()) || is_sensitive_path(&file_path) {
                        return Err("Không được phép đọc đường dẫn file này".to_string());
                    }

                    let metadata = std::fs::metadata(&file_path)
                        .map_err(|_| "Không tìm thấy file cục bộ".to_string())?;
                    if !metadata.is_file() {
                        return Err("Đường dẫn không phải file".to_string());
                    }
                    let total = metadata.len();
                    let mut start = 0_u64;
                    let mut end = total.saturating_sub(1);
                    let mut partial = false;

                    if let Some(header) = range_header.as_deref() {
                        let raw = header
                            .strip_prefix("bytes=")
                            .ok_or_else(|| "Range không hợp lệ".to_string())?;
                        if raw.contains(',') {
                            return Err("Chỉ hỗ trợ một byte range".to_string());
                        }
                        let (start_raw, end_raw) = raw
                            .split_once('-')
                            .ok_or_else(|| "Range không hợp lệ".to_string())?;
                        start = start_raw
                            .parse::<u64>()
                            .map_err(|_| "Range không hợp lệ".to_string())?;
                        if !end_raw.is_empty() {
                            end = end_raw
                                .parse::<u64>()
                                .map_err(|_| "Range không hợp lệ".to_string())?;
                        }
                        if total == 0 || start >= total || end < start {
                            return Err("Range nằm ngoài file".to_string());
                        }
                        end = end.min(total - 1);
                        partial = true;
                    }

                    let requested_len = if total == 0 { 0 } else { end - start + 1 };
                    let body = if method.eq_ignore_ascii_case("HEAD") || requested_len == 0 {
                        Vec::new()
                    } else {
                        let body_len = usize::try_from(requested_len)
                            .map_err(|_| "File quá lớn để đọc trên hệ thống này".to_string())?;
                        let mut file = std::fs::File::open(&file_path)
                            .map_err(|_| "Không mở được file cục bộ".to_string())?;
                        std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(start))
                            .map_err(|_| "Không đặt được vị trí đọc file".to_string())?;
                        let mut bytes = vec![0_u8; body_len];
                        std::io::Read::read_exact(&mut file, &mut bytes)
                            .map_err(|_| "Không đọc đủ dữ liệu file".to_string())?;
                        bytes
                    };

                    let content_type = match ext.as_str() {
                        "pdf" => "application/pdf",
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "tif" | "tiff" => "image/tiff",
                        "bmp" => "image/bmp",
                        "webp" => "image/webp",
                        "svg" => "image/svg+xml",
                        "ttf" | "ttc" => "font/ttf",
                        "otf" => "font/otf",
                        "json" => "application/json",
                        "txt" | "csv" => "text/plain; charset=utf-8",
                        _ => "application/octet-stream",
                    };
                    let mut builder = http::Response::builder()
                        .status(if partial { 206 } else { 200 })
                        .header("Content-Type", content_type)
                        .header("Content-Length", requested_len.to_string())
                        .header("Accept-Ranges", "bytes")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
                        .header("Cache-Control", "no-store")
                        .header("X-Content-Type-Options", "nosniff");
                    if partial {
                        builder = builder.header(
                            "Content-Range",
                            format!("bytes {}-{}/{}", start, end, total),
                        );
                    }
                    builder.body(body).map_err(|e| e.to_string())
                })
                .await;

                match result {
                    Ok(Ok(response)) => responder.respond(response),
                    Ok(Err(message)) => {
                        let response = http::Response::builder()
                            .status(403)
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Content-Type", "text/plain; charset=utf-8")
                            .body(message.into_bytes())
                            .unwrap_or_else(|_| http::Response::new(Vec::new()));
                        responder.respond(response);
                    }
                    Err(error) => {
                        let response = http::Response::builder()
                            .status(500)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(format!("Lỗi đọc file: {}", error).into_bytes())
                            .unwrap_or_else(|_| http::Response::new(Vec::new()));
                        responder.respond(response);
                    }
                }
            });
        })
        .register_asynchronous_uri_scheme_protocol("tile", |_ctx, request, responder| {
            // tile://localhost/{encoded_filepath}/{page}/{zoom}/{rot}/{cx}/{cy}/{cw}/{ch}
            let url = request.uri().to_string();

            tauri::async_runtime::spawn(async move {
                let render_request = match parse_tile_protocol_request(&url) {
                    Ok(request) => request,
                    Err(message) => {
                        let response = http::Response::builder()
                            .status(400)
                            .header("Content-Type", "text/plain; charset=utf-8")
                            .body(message.into_bytes())
                            .unwrap_or_else(|_| http::Response::new(Vec::new()));
                        responder.respond(response);
                        return;
                    }
                };
                let _permits = match acquire_render_request_permits(render_request.purpose).await {
                    Ok(permits) => permits,
                    Err(message) => {
                        let response = http::Response::builder()
                            .status(503)
                            .header("Content-Type", "text/plain; charset=utf-8")
                            .body(message.into_bytes())
                            .unwrap_or_else(|_| http::Response::new(Vec::new()));
                        responder.respond(response);
                        return;
                    }
                };

                // Now we are allowed to use 1 thread from the OS blocking pool
                let res = tauri::async_runtime::spawn_blocking(move || {
                    let context = tile_protocol_render_context(&render_request);

                    match pdf_engine::render_worker::render_display_with_policy(
                        &render_request.file_path,
                        render_request.page,
                        render_request.zoom,
                        render_request.rotation,
                        render_request.clip_x,
                        render_request.clip_y,
                        render_request.clip_w,
                        render_request.clip_h,
                        Some(&context),
                    )? {
                        pdf_engine::render_worker::WorkerAttempt::Completed(output) => {
                            Ok(output.bytes)
                        }
                        pdf_engine::render_worker::WorkerAttempt::Disabled => {
                            render_tile_png_in_process(
                                &render_request.file_path,
                                render_request.page,
                                render_request.zoom,
                                render_request.rotation,
                                render_request.clip_x,
                                render_request.clip_y,
                                render_request.clip_w,
                                render_request.clip_h,
                            )
                        }
                        pdf_engine::render_worker::WorkerAttempt::FallbackBeforeStart(reason) => {
                            log::warn!("[RENDER_WORKER] tile protocol fallback: {}", reason);
                            render_tile_png_in_process(
                                &render_request.file_path,
                                render_request.page,
                                render_request.zoom,
                                render_request.rotation,
                                render_request.clip_x,
                                render_request.clip_y,
                                render_request.clip_w,
                                render_request.clip_h,
                            )
                        }
                    }
                }).await;

                match res {
                    Ok(Ok(image_bytes)) => {
                        let resp = http::Response::builder()
                            .status(200)
                            .header("Content-Type", "image/png")
                            .header("Cache-Control", "max-age=3600, immutable")
                            .body(image_bytes)
                            .unwrap_or_else(|_| http::Response::new(Vec::new()));
                        responder.respond(resp);
                    }
                    Ok(Err(e)) => {
                        let resp = http::Response::builder()
                            .status(500)
                            .body(format!("Render error: {}", e).into_bytes())
                            .unwrap_or_else(|_| http::Response::new(Vec::new()));
                        responder.respond(resp);
                    }
                    Err(e) => {
                        let resp = http::Response::builder()
                            .status(500)
                            .body(format!("Join error: {}", e).into_bytes())
                            .unwrap_or_else(|_| http::Response::new(Vec::new()));
                        responder.respond(resp);
                    }
                }
            });
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // Kill sidecar khi app thoát (mọi lý do) → chống pdf-inspector-backend.exe
            // treo ngầm làm NSIS update báo "Error opening file for writing".
            if let tauri::RunEvent::Exit = _event {
                #[cfg(all(not(debug_assertions), target_os = "windows"))]
                RUN_EVENT_EXIT_SEEN.store(true, Ordering::Release);
                // [PROC-LIFECYCLE FIX 2026-08-28 §UP.4] Sidecar bị diệt TRƯỚC display worker.
                // Trước đây thứ tự ngược lại và `shutdown_render_worker()` không có trần thời
                // gian, nên một worker kẹt là đủ để `kill_sidecar()` không bao giờ được gọi —
                // đúng ca "đóng app rồi mà pdf-inspector-backend.exe vẫn còn trong Task
                // Manager". Sidecar mới là tiến trình khóa file lúc NSIS ghi bản mới và là
                // tiến trình ngốn RAM, nên nó phải chết trước; worker giờ có deadline riêng.
                #[cfg(all(not(debug_assertions), target_os = "windows"))]
                {
                    let _lifecycle_guard = sidecar_lifecycle_guard();
                    SIDECAR_SHUTDOWN.store(true, Ordering::Release);
                    let _ = shutdown_sidecar_gracefully_locked();
                }
                pdf_engine::render_worker::shutdown_render_worker();
            }
        });
}
