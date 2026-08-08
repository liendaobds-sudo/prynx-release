use tauri::http::{self};
use tauri::Manager;

// Add state struct for PDFium
use image::ImageEncoder;
use pdfium_render::prelude::*;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Response;

// `creation_flags` (ẩn cửa sổ console) đến từ trait CommandExt — chỉ cần ở các block
// bảo mật release-only trên Windows. Guard theo cfg để debug không cảnh báo unused.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
use std::os::windows::process::CommandExt;

mod external_app;
mod pdf_color_risk;
mod pdf_engine;
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

// STARTUP (fix 2026-08-04): cửa sổ chính chỉ được hiện sau khi Rust setup và
// sidecar đã sẵn sàng. Nếu user mở shortcut lần hai trong lúc cold-start, callback
// single-instance vẫn nhận args nhưng không làm lộ khung WebView trong suốt.
static APP_STARTUP_READY: AtomicBool = AtomicBool::new(false);
static FRONTEND_INTERACTIVE_RECORDED: AtomicBool = AtomicBool::new(false);

// PID tiến trình sidecar Python — để KILL khi thoát app. Nếu không kill,
// pdf-inspector-backend.exe treo ngầm sau khi đóng app → lần UPDATE, NSIS không
// ghi đè được file đang chạy ("Error opening file for writing"). Chỉ dùng ở release
// (dev không spawn sidecar). Nuitka --onefile spawn tiến trình con nên phải taskkill
// /T (cả cây) theo PID, không thể chỉ child.kill() (chỉ diệt bootstrap, python treo).
#[cfg(not(debug_assertions))]
static SIDECAR_PID: OnceLock<u32> = OnceLock::new();

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn kill_sidecar() {
    if let Some(&pid) = SIDECAR_PID.get() {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
        log::warn!("[SIDECAR] taskkill /T /F PID={} khi thoat app", pid);
    }
}

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
const SIDECAR_STARTUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(any(test, all(not(debug_assertions), target_os = "windows")))]
const SIDECAR_STARTUP_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

#[cfg(any(test, not(debug_assertions)))]
#[derive(Debug, Eq, PartialEq)]
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

#[cfg(test)]
mod sidecar_startup_tests {
    use super::{
        prepare_sidecar_storage, sidecar_startup_timeout_error, startup_retry_delay,
        verify_startup_proof, SIDECAR_STARTUP_TIMEOUT,
    };
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
    fn cua_so_startup_hien_som_va_asset_tu_chua_du_thong_tin() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        let startup = windows
            .iter()
            .find(|window| window["label"] == "startup")
            .expect("phải có cửa sổ startup riêng");

        assert_eq!(startup["visible"], true);
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

// LRU các PdfPage đang mở. Mỗi page giữ ảnh đã giải nén → tốn RAM, nên có cận.
// Cap 24 (trước 10): đo thật 2026-07-22 cho thấy decode trang lần đầu ~800ms là chi
// phí lớn nhất khi cuộn (cả view chính lẫn thumbnail dùng CHUNG LRU này). Giữ nhiều
// trang mở hơn → cuộn qua lại + prefetch trang lân cận không phải decode lại. 24 ×
// ~16MB/trang (file bình nặng) ≈ 384MB trần/doc — đủ mượt mà không phình như 40+.
const PAGE_LRU_CAP: usize = 24;
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
    color_risk: pdf_color_risk::PdfColorRiskSummary,
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

fn parse_pdf_structure(
    bytes: &[u8],
    total_bytes: Option<u64>,
) -> Result<ParsedPdfStructure, String> {
    // PAGEBOX (audit 2026-08-04 §W1.PB6): parse ngay trên buffer sẽ chuyển cho
    // PDFium; Document lopdf được drop trước khi PDFium mở để không giữ hai bản PDF.
    let document = lopdf::Document::load_mem_with_options(
        bytes,
        lopdf_load_options_for_total_ram(total_bytes),
    )
    .map_err(|error| {
        format!("Không thể đọc cấu trúc trang PDF an toàn để xác định /UserUnit: {error}")
    })?;
    // COLOR (audit 2026-08-07 §GV.3): tận dụng cùng lần parse để nhận diện trang
    // CMYK/DeviceN/transparency; không đọc file lần hai và không giải mã bitmap.
    Ok(ParsedPdfStructure {
        user_units: collect_pdf_user_units(&document),
        color_risk: pdf_color_risk::analyze_pdf_color_risk(&document),
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

/// Breadcrumb khởi động → %APPDATA%\PrynX\logs\startup_debug.log
fn startup_breadcrumb(msg: &str) {
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

fn reveal_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Không tìm thấy cửa sổ chính của PrynX".to_string())?;
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
        // Release chỉ lưu log info khi QA bật PRYNX_PERF=1; mặc định không thêm I/O.
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
) -> Result<Arc<CachedDocument>, String> {
    // I/O và parse không giữ cache/PDFium mutex. Cùng buffer này được đọc đúng một
    // lần, parse bằng lopdf, drop parser rồi mới move vào PDFium để giảm peak RAM.
    let bytes = read_pdf_bytes_for_identity(file_path, file_identity)?;
    let ParsedPdfStructure {
        user_units,
        color_risk,
    } = parse_pdf_structure(&bytes, system_total_memory_bytes())?;
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
    let mut pool = Vec::with_capacity(pool_size);
    for _ in 0..pool_size {
        pool.push(OnceLock::new());
    }
    let _ = pool[0].set(DocHandle {
        pages: Mutex::new(PageLru::new(PAGE_LRU_CAP)),
        lock: Mutex::new(()),
        doc,
    });
    Ok(Arc::new(CachedDocument {
        pool,
        user_units,
        color_risk,
        file_identity,
        next: AtomicUsize::new(0),
    }))
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
) -> Result<Arc<CachedDocument>, String> {
    let (existing, stale) = {
        let mut cache = lock_mutex(document_cache());
        cached_document_for_identity(&mut cache, file_path, file_identity)
    };
    // Document cùng path nhưng khác size/mtime phải đóng ngoài cache mutex.
    drop(stale);
    if let Some(existing) = existing {
        return Ok(existing);
    }

    // Double-checked insert: đọc/parse file bên ngoài cache mutex. Hai request đua nhau
    // có thể cùng load; chỉ một entry cùng identity thắng.
    let candidate = build_cached_document(pdfium, file_path, file_identity)?;
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
    get_or_load_cached_document_with_identity(pdfium, file_path, file_identity)
}

struct SystemFilesState(Mutex<Vec<String>>);

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

fn preview_perf_enabled() -> bool {
    perf_env_value_enabled(std::env::var("PRYNX_PERF").ok().as_deref())
}

#[tauri::command]
fn preview_perf_logging_enabled() -> bool {
    // PERF (audit 2026-08-05 §PERF.3): FE hỏi đúng một lần rồi cache kết quả;
    // release mặc định không ghi Desktop và không gửi beacon.
    preview_perf_enabled()
}

// ── Đo hiệu năng render (đo thật, không đoán) ────────────────────────────────
// Đường log riêng cho render/thumbnail, set 1 lần trong setup(). KHÔNG dùng
// chrono::Local::now() (đã PANIC ở release trong render_tile_png — xem note ~:609)
// → dùng epoch millis từ SystemTime (không timezone, không panic). Bật khi:
//   - debug build (dev chạy run_dev.bat → tự bật, không cần thao tác), HOẶC
//   - env PRYNX_PERF=1 (opt-in cho bản release khi cần chẩn đoán máy khách).
static PERF_LOG_PATH: OnceLock<std::path::PathBuf> = OnceLock::new();

fn perf_enabled() -> bool {
    cfg!(debug_assertions) || preview_perf_enabled()
}

fn perf_log(msg: &str) {
    if !perf_enabled() {
        return;
    }
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

// Cho FE đẩy dòng đo (TilePerf / ViewerPreview) vào CÙNG file PrynX_RenderPerf.log
// → user chỉ cần gửi 1 file thay vì mở devtools copy console. Chỉ ghi khi
// perf_enabled() (debug build / PRYNX_PERF=1). Gắn prefix "FE " để phân biệt
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

fn nuitka_cache_name_for_app_version(version: &str) -> Option<String> {
    let (core, prerelease) = version
        .split_once('-')
        .map(|(core, prerelease)| (core, Some(prerelease)))
        .unwrap_or((version, None));
    let core_parts = core
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if core_parts.len() != 3 {
        return None;
    }
    let revision = prerelease
        .and_then(|value| value.rsplit('.').next())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let numeric = format!(
        "{}.{}.{}.{}",
        core_parts[0], core_parts[1], core_parts[2], revision
    );
    // Nuitka ghép PRODUCT_VERSION-FILE_VERSION khi build truyền cả hai cờ;
    // build_production.ps1 luôn truyền cùng NUMERIC_VERSION cho hai cờ này.
    Some(format!("sidecar-{numeric}-{numeric}"))
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
    if !base_dir.is_dir() {
        return Ok((Vec::new(), Vec::new()));
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
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
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
    for (_, name, _) in &entries {
        if keep.len() >= 2 {
            break;
        }
        keep.insert(name.clone());
    }

    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for (_, name, path) in entries {
        if keep.contains(&name) {
            continue;
        }
        match remove_sidecar_cache_with_retry(&path) {
            Ok(()) => removed.push(name),
            Err(error) => failed.push(format!("{name}: {error}")),
        }
    }
    Ok((removed, failed))
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
    log::error!(
        "[FRONTEND_UI] area={} error_id={} version={} message={} component_stack={}",
        compact_log_field(area, 80),
        compact_log_field(error_id, 80),
        compact_log_field(app_version, 40),
        compact_log_field(message, 800),
        compact_log_field(component_stack.unwrap_or_default(), 5000),
    );
}

#[tauri::command]
async fn close_pdf_document(file_path: String) -> Result<bool, String> {
    if is_sensitive_path(&file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let Some(cache_lock) = DOC_CACHE.get() else {
            return Ok(false);
        };
        let removed = {
            let mut cache = lock_mutex(cache_lock);
            cache.remove(&file_path)
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
    })
    .await
    .unwrap_or_else(|_| Err("Task panicked".into()))
}

#[tauri::command]
async fn get_pdf_metadata(file_path: String) -> Result<serde_json::Value, String> {
    if is_sensitive_path(&file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let pdfium = ensure_pdfium()?;
        let document_arc = get_or_load_cached_document(pdfium, &file_path)?;

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
            "colorRisk": document_arc.color_risk,
            "renderEngine": current_pdfium_runtime_identity(),
        }))
    })
    .await
    .unwrap_or_else(|_| Err("Task panicked".into()))
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

fn render_tile_png(
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
        if let Ok(bytes) = std::fs::read(&dpath) {
            if !bytes.is_empty() {
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
    }

    let pdfium = ensure_pdfium()?;
    let document_arc = get_or_load_cached_document_with_identity(pdfium, file_path, file_identity)?;

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
            pages: Mutex::new(PageLru::new(PAGE_LRU_CAP)),
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
        let _ = std::fs::write(&dpath, &buffer);
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

// Giới hạn render đồng thời cho lệnh IPC render_pdf_page (giống TILE_SEMAPHORE của
// đường tile://). Viewport-tiling gửi nhiều ô cùng lúc → nếu không chặn, mỗi render
// round-robin qua doc pool khiến mỗi handle decode lại page (RAM) + spawn_blocking
// không giới hạn. Semaphore ~4 giữ song song vừa phải, tránh thrash (audit render).
static RENDER_SEMAPHORE: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::OnceLock::new();

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
) -> Result<tauri::ipc::Response, String> {
    let sem = RENDER_SEMAPHORE.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
    let command_t0 = std::time::Instant::now();
    let kind = if clip_w.is_some() && clip_h.is_some() {
        "tile"
    } else {
        "page"
    };
    let sem_t0 = std::time::Instant::now();
    let _permit = sem
        .acquire()
        .await
        .map_err(|_| "Render semaphore closed".to_string())?;
    let sem_wait_ms = sem_t0.elapsed().as_millis();
    let submitted_t0 = std::time::Instant::now();
    let (result, worker_queue_ms, core_ms) = tauri::async_runtime::spawn_blocking(move || {
        let worker_queue_ms = submitted_t0.elapsed().as_millis();
        let core_t0 = std::time::Instant::now();
        let result = match render_tile_png(
            &file_path, page, zoom, rotation, clip_x, clip_y, clip_w, clip_h,
        ) {
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
fn get_startup_args() -> Vec<String> {
    std::env::args().collect()
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
fn is_sensitive_path(path: &str) -> bool {
    let norm = path.replace('/', "\\").to_lowercase();
    // Chống path traversal
    if norm.contains("\\..\\") || norm.ends_with("\\..") || norm.starts_with("..\\") {
        return true;
    }

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

/// Guard RIÊNG cho GHI: ngoài các vị trí nhạy cảm dùng chung (is_sensitive_path),
/// chặn thêm thư mục hệ thống Windows/Program Files để renderer (nếu bị chèn mã) KHÔNG
/// ghi đè file hệ thống. KHÔNG gộp vào is_sensitive_path vì lệnh ĐỌC cần truy cập
/// C:\Windows\Fonts (đọc font hệ thống hợp lệ).
fn is_sensitive_write_path(path: &str) -> bool {
    if is_sensitive_path(path) {
        return true;
    }
    let norm = path.replace('/', "\\").to_lowercase();
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
                sys_dirs.push(v.replace('/', "\\").to_lowercase());
            }
        }
    }
    sys_dirs
        .iter()
        .any(|d| norm == *d || norm.starts_with(&format!("{}\\", d)))
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

#[tauri::command]
fn write_batch_pdf(
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

#[tauri::command]
fn copy_batch_pdf(
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
fn write_file_atomic(path: String, contents: Vec<u8>) -> Result<(), String> {
    // GHI FILE NGUYÊN TỬ (chống hỏng/mất file gốc khi crash giữa lúc ghi đè).
    // Ghi ra file TẠM cùng thư mục rồi std::fs::rename (= MoveFileEx REPLACE_EXISTING
    // trên Windows, rename(2) trên Unix → thay thế NGUYÊN TỬ trên cùng volume). Lệnh
    // Rust nên KHÔNG vướng scope plugin-fs → dùng được cho path tùy ý user chọn.
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
    let target = std::path::Path::new(&path);
    let dir = match target.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let fname = target.file_name().and_then(|n| n.to_str()).unwrap_or("out");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{}.{}.{}.tmp", fname, std::process::id(), nanos));

    if let Err(e) = std::fs::write(&tmp, &contents) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi ghi file tạm: {}", e));
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi thay thế file đích: {}", e));
    }
    Ok(())
}

#[tauri::command]
fn copy_file_atomic(source: String, path: String) -> Result<(), String> {
    // COPY file đĩa→đĩa NGUYÊN TỬ, không đọc bytes vào JS. Vì sao: kết quả bình
    // sách/VDP là file lớn (hàng trăm MB) đã nằm trên đĩa; đường cũ đọc toàn bộ vào
    // JS rồi truyền Uint8Array qua IPC cho write_file_atomic → "RangeError: Invalid
    // array length" khi serialize khối bytes khổng lồ. Copy thẳng path→path tránh
    // hẳn round-trip đó. Ghi temp cùng thư mục đích rồi rename (nguyên tử, cùng volume).
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
    let source_ext = std::path::Path::new(&source)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if source_ext != ext || !allowed.contains(&source_ext.as_str()) {
        return Err("Source and destination file types must match an allowed type".to_string());
    }
    if is_sensitive_path(&source) || is_sensitive_write_path(&path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let source_path = std::path::Path::new(&source);
    if !source_path.is_file() {
        return Err("Source file does not exist".to_string());
    }
    let target = std::path::Path::new(&path);
    let dir = match target.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let fname = target.file_name().and_then(|n| n.to_str()).unwrap_or("out");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{}.{}.{}.tmp", fname, std::process::id(), nanos));

    if let Err(e) = std::fs::copy(source_path, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi copy file: {}", e));
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Lỗi thay thế file đích: {}", e));
    }
    Ok(())
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
fn get_pending_system_files(state: tauri::State<SystemFilesState>) -> Vec<String> {
    let mut pending = lock_mutex(&state.0);
    let files = pending.clone();
    pending.clear();
    files
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
            color_risk: pdf_color_risk::PdfColorRiskSummary::empty(),
            file_identity: identity,
            next: AtomicUsize::new(0),
        })
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

    #[test]
    fn batch_write_never_overwrites_existing_pdf() {
        let dir = test_dir("write");
        std::fs::write(dir.join("report.pdf"), b"%PDF-original").unwrap();

        let output = write_batch_pdf(
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
        }
        for value in [None, Some(""), Some("0"), Some("false"), Some("off")] {
            assert!(!perf_env_value_enabled(value));
        }
    }

    #[test]
    fn version_tauri_khop_ten_cache_nuitka() {
        assert_eq!(
            nuitka_cache_name_for_app_version("1.0.0-rc.3").as_deref(),
            Some("sidecar-1.0.0.3-1.0.0.3")
        );
        assert_eq!(
            nuitka_cache_name_for_app_version("2.4.1").as_deref(),
            Some("sidecar-2.4.1.0-2.4.1.0")
        );
        assert!(nuitka_cache_name_for_app_version("khong-hop-le").is_none());
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
    fn khong_xac_dinh_duoc_current_thi_giu_hai_cache_moi_nhat() {
        let root = test_root("unknown_current");
        let base = root.join("PrynX");
        for name in [
            "sidecar-1.0.0.1-1.0.0.1",
            "sidecar-1.0.0.2-1.0.0.2",
            "sidecar-1.0.0.3-1.0.0.3",
        ] {
            std::fs::create_dir_all(base.join(name)).unwrap();
        }

        let (removed, failed) =
            prune_sidecar_caches(&base, Some("sidecar-1.0.0.9-1.0.0.9")).unwrap();

        assert_eq!(removed, vec!["sidecar-1.0.0.1-1.0.0.1"]);
        assert!(failed.is_empty());
        assert!(base.join("sidecar-1.0.0.3-1.0.0.3").is_dir());
        assert!(base.join("sidecar-1.0.0.2-1.0.0.2").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic hook: ghi mọi panic (message + vị trí) ra %APPDATA%\PrynX\logs\rust_panic.log
    // để chẩn đoán sự cố ở bản release (nơi không có stdout/console).
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
                let _ = writeln!(f, "[{}] PANIC: {} | at {:?}", now, info, info.location());
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
        let flags = "--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding";
        let merged = if existing.trim().is_empty() {
            flags.to_string()
        } else {
            format!("{} {}", existing, flags)
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }

    startup_breadcrumb("process entry — creating windows");

    tauri::Builder::default()
        .manage(SystemFilesState(Mutex::new(Vec::new())))
        // SEC (audit 2026-08-04 §BE.03): không expose command nghiệp vụ không có
        // consumer/quyền native. Mọi bình bản và xóa đường bế đi qua sidecar đã gate.
        .invoke_handler(tauri::generate_handler![render_pdf_page, get_pdf_metadata, close_pdf_document, get_system_memory_status, get_startup_args, mark_frontend_interactive, read_system_file, get_file_size, stat_system_file, list_batch_folder_files, write_batch_pdf, copy_batch_pdf, get_pending_system_files, write_file_atomic, copy_file_atomic, read_dir_json, preview_perf_logging_enabled, append_render_perf, log_frontend_error, pdf_engine::print::print_pdf, pdf_engine::print::print_pdf_direct, pdf_engine::print::cancel_print_job, pdf_engine::print::open_printer_properties, pdf_engine::print::list_printers, pdf_engine::print::get_printer_geometry, pdf_engine::print::delete_print_temp, pdf_engine::print::log_print_event, security::get_hardware_id, security::store_license, security::load_license, security::delete_license, security::register_validated_key, security::clear_validated_keys, security::sign_api_request, security::store_last_online, security::load_last_online, security::store_license_token, security::load_license_token, security::delete_license_token, normalize_image_to_png, normalize_image_bytes, external_app::detect_design_apps, external_app::launch_external_app])
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(state) = app.try_state::<SystemFilesState>() {
                if let Ok(mut pending) = state.0.lock() {
                    pending.extend(args);
                }
            }

            if APP_STARTUP_READY.load(Ordering::Acquire) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_always_on_top(true);
                    let _ = window.set_always_on_top(false);
                    let _ = window.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(startup_window) = app.get_webview_window("startup") {
                #[cfg(debug_assertions)]
                {
                    // Dev không chờ Nuitka sidecar; đóng ngay để tránh flash thừa.
                    let _ = startup_window.close();
                }
                #[cfg(not(debug_assertions))]
                {
                    // PERF (audit 2026-08-05 §PERF.5): không gọi is_visible() trong
                    // setup vì event loop chưa chạy, WebView2 sẽ chờ rồi báo
                    // "failed to receive message". Config/test đảm bảo visible=true;
                    // setup phải trả quyền sớm để splash thật sự paint và phản hồi.
                    let _ = startup_window;
                    startup_breadcrumb("native splash: created");
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

            // Đường log đo render (perf_log). Ghi ra Desktop cạnh PrynX_Performance.log
            // để dễ tìm. Chỉ ghi khi perf_enabled() (debug build hoặc PRYNX_PERF=1).
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
            // pdfium vẫn warm-up; anti-debug chỉ GHI LOG (không exit) để chẩn đoán.
            // ══════════════════════════════════════════════════════════════
            #[cfg(not(debug_assertions))]
            {
                startup_breadcrumb("release setup: begin");
                match ensure_pdfium() {
                    Ok(_) => {
                        log::info!("[SECURITY] pdfium warmed up at startup");
                        startup_breadcrumb("pdfium: OK");
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
                    let _ = std::process::Command::new("powershell")
                        .args(["-NoProfile", "-Command", &format!(
                            "[System.Windows.MessageBox]::Show('{}', 'PrynX Security', 'OK', 'Error')",
                            e.replace('\'', "''")
                        )])
                        .creation_flags(0x08000000)
                        .output();
                    std::process::exit(1);
                    }
                }
            }

            // SECURITY: Generate a CSPRNG sidecar token for API authentication.
            // Uses OS-level cryptographic random (Windows CryptGenRandom / BCryptGenRandom).
            let sidecar_token: String = {
                use rand::Rng;
                let mut rng = rand::thread_rng();
                let bytes: [u8; 32] = rng.gen();
                bytes.iter().map(|b| format!("{:02X}", b)).collect::<String>()
            };

            // VECTOR #5 FIX: Store token in Rust memory ONLY (not in JS).
            // Frontend will call invoke('sign_api_request') to get signed headers.
            security::set_sidecar_token(&sidecar_token);

            // ══════════════════════════════════════════════════════════════
            // VECTOR #6 FIX: Pass token via stdin pipe (NOT file).
            // Token NEVER touches disk — zero race condition window.
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
                        let _ = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-Command", &format!(
                                "[System.Windows.MessageBox]::Show('Khong xac dinh duoc duong dan ung dung ({}). Vui long cai dat lai.', 'PrynX Security', 'OK', 'Error')",
                                e.replace('\'', "''")
                            )])
                            .creation_flags(0x08000000)
                            .output();
                        std::process::exit(1);
                    }
                };
                if let Err(e) = verify_sidecar_integrity(&sidecar_path) {
                    log::error!("[SECURITY] {}", e);
                    startup_breadcrumb(&format!("sidecar integrity: FAIL {e}"));
                    let _ = std::process::Command::new("powershell")
                        .args(["-NoProfile", "-Command", &format!(
                            "[System.Windows.MessageBox]::Show('{}', 'PrynX Security', 'OK', 'Error')",
                            e.replace('\'', "''")
                        )])
                        .creation_flags(0x08000000)
                        .output();
                    std::process::exit(1);
                }
                startup_breadcrumb("sidecar integrity: OK");

                let sidecar = match app.shell().sidecar("pdf-inspector-backend") {
                    Ok(s) => s,
                    Err(e) => {
                        log::error!("[SIDECAR] Khong tim thay binary sidecar: {}", e);
                        startup_breadcrumb(&format!("sidecar binary: MISSING {e}"));
                        let _ = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-Command",
                                "[System.Windows.MessageBox]::Show('Khong tim thay tien trinh nen (pdf-inspector-backend.exe). Co the bi phan mem diet virus cach ly hoac thieu file. Vui long khoi phuc/loai tru file roi mo lai ung dung.', 'PrynX', 'OK', 'Error')"])
                            .creation_flags(0x08000000)
                            .output();
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
                        let _ = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-Command", &format!(
                                "[System.Windows.MessageBox]::Show('{}', 'PrynX', 'OK', 'Error')",
                                error.replace('\'', "''")
                            )])
                            .creation_flags(0x08000000)
                            .output();
                        std::process::exit(1);
                    }
                };
                startup_breadcrumb(&format!(
                    "sidecar storage: {}",
                    sidecar_storage.working_dir.display()
                ));
                // ══════════════════════════════════════════════════════════════
                // ZOMBIE FIX: Giành lại port 8321 TRƯỚC khi spawn sidecar mới.
                // Nếu phiên trước app chết BẨN (OOM khi Optimize file lớn, End Task,
                // crash) thì kill_sidecar() (chỉ chạy ở RunEvent::Exit) KHÔNG chạy →
                // pdf-inspector-backend.exe sống sót thành ZOMBIE, tiếp tục giữ 8321
                // với TOKEN CŨ. Sidecar mới bind 8321 thất bại → chết câm → frontend
                // (token mới) chạm zombie (token cũ) → "invalid sidecar token".
                //
                // Kill theo TÊN (rất đặc trưng, không đụng hàng): single-instance đã
                // chặn 2 app hợp lệ, và sidecar của instance NÀY chưa spawn (dòng ngay
                // dưới) → mọi pdf-inspector-backend.exe đang tồn tại đều là zombie.
                // /IM quét cả cây worker Nuitka trong 1 lệnh. Exit 128 (không có
                // process) là BÌNH THƯỜNG → nuốt. creation_flags = CREATE_NO_WINDOW.
                let _ = std::process::Command::new("taskkill")
                    .args(["/IM", "pdf-inspector-backend.exe", "/F"])
                    .creation_flags(0x08000000)
                    .output();
                // Chờ port free: bind test là cách kiểm tin cậy nhất ("có ai đang
                // LISTEN?"). Bind OK → drop ngay (nhả port) → spawn. Trần cứng 1s
                // (20×50ms): vượt trần vẫn spawn (fail-open sang lưới an toàn ở
                // main.py — Python sẽ log rõ + exit 48 nếu port thực sự kẹt).
                let mut port_is_free = false;
                for _ in 0..20 {
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
                    let _ = std::process::Command::new("powershell")
                        .args(["-NoProfile", "-Command",
                            "[System.Windows.MessageBox]::Show('Cong noi bo 8321 dang bi chiem. PrynX tu choi khoi dong de bao ve du lieu. Hay dong tien trinh lien quan va thu lai.', 'PrynX Security', 'OK', 'Error')"])
                        .creation_flags(0x08000000)
                        .output();
                    std::process::exit(1);
                }

                let spawn_result = sidecar
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
                        // Cận chống-lùi-giờ PHẢI ≥ TTL token edge function cấp.
                        // Set qua env để override default compiled cũ mà KHÔNG cần recompile Nuitka.
                        // TTL server đã rút 7 ngày → 72h (audit 2026-07-25); cận GIỮ 8 ngày
                        // (691200s) trong giai đoạn chuyển tiếp vì token 7 ngày cũ còn hạn.
                        // Sau khi chúng hết hạn (≥7 ngày kể từ deploy), hạ xuống "345600" (4 ngày).
                        ("PRYNX_MAX_TOKEN_LIFETIME_SECONDS", "691200"),
                    ])
                    .spawn();
                let (mut rx, mut child) = match spawn_result {
                    Ok(v) => v,
                    Err(e) => {
                        log::error!("[SIDECAR] Spawn that bai: {}", e);
                        let _ = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-Command",
                                "[System.Windows.MessageBox]::Show('Khong khoi dong duoc tien trinh nen. Vui long mo lai ung dung; neu van loi hay lien he ho tro.', 'PrynX', 'OK', 'Error')"])
                            .creation_flags(0x08000000)
                            .output();
                        std::process::exit(1);
                    }
                };

                // Forward stdout/stderr/kết-thúc của sidecar vào log Rust. Trước đây
                // _rx bị VỨT → sidecar chết câm (vd bind 8321 thất bại) không để lại
                // dấu vết → sự cố "invalid sidecar token" khó điều tra suốt thời gian
                // dài. Nay log Terminated{code} → bắt được "exit 48 = port bận" tức
                // thì. Đọc rx còn tránh đầy buffer pipe làm sidecar block. Fire-and-forget.
                let sidecar_exited = Arc::new(AtomicBool::new(false));
                let sidecar_exited_for_events = Arc::clone(&sidecar_exited);
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_shell::process::CommandEvent;
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => {
                                log::info!("[SIDECAR-OUT] {}", String::from_utf8_lossy(&bytes).trim_end());
                            }
                            CommandEvent::Stderr(bytes) => {
                                log::warn!("[SIDECAR-ERR] {}", String::from_utf8_lossy(&bytes).trim_end());
                            }
                            CommandEvent::Terminated(payload) => {
                                sidecar_exited_for_events.store(true, Ordering::Release);
                                log::error!("[SIDECAR] Terminated code={:?} signal={:?}", payload.code, payload.signal);
                            }
                            CommandEvent::Error(e) => {
                                sidecar_exited_for_events.store(true, Ordering::Release);
                                log::error!("[SIDECAR] Error: {}", e);
                            }
                            _ => {}
                        }
                    }
                });

                // Lưu PID để KILL cả cây tiến trình khi thoát app (chống treo ngầm →
                // update NSIS không ghi đè được file). set() 1 lần, bỏ qua nếu đã có.
                let _ = SIDECAR_PID.set(child.pid());

                // Write token via stdin pipe — no file on disk ever
                let token_line = format!("TOKEN:{}\n", sidecar_token);
                if let Err(e) = child.write(token_line.as_bytes()) {
                    log::error!("[SIDECAR] Ghi token vao stdin that bai: {}", e);
                    kill_sidecar();
                    std::process::exit(1);
                }
                startup_breadcrumb(&format!(
                    "sidecar startup proof: waiting (timeout={}s)",
                    SIDECAR_STARTUP_TIMEOUT.as_secs()
                ));
                if let Err(e) = verify_sidecar_startup(&sidecar_token, sidecar_exited.as_ref()) {
                    log::error!("[SIDECAR] Startup identity check failed: {}", e);
                    startup_breadcrumb(&format!("sidecar startup proof: FAIL {e}"));
                    kill_sidecar();
                    let _ = std::process::Command::new("powershell")
                        .args(["-NoProfile", "-Command",
                            "[System.Windows.MessageBox]::Show('Tien trinh nen khong xac thuc duoc. PrynX da dung khoi dong de bao ve du lieu.', 'PrynX Security', 'OK', 'Error')"])
                        .creation_flags(0x08000000)
                        .output();
                    std::process::exit(1);
                }

                log::info!("Python backend sidecar started on port 8321 (token via stdin pipe)");
                startup_breadcrumb("sidecar: ready (startup proof OK)");

                // PERF (audit 2026-08-05 §PERF.4): chỉ prune SAU khi sidecar hiện
                // tại đã xác thực/sẵn sàng. Chạy nền để xóa cache ~GB không kéo dài
                // cold start; giữ current + một previous và bỏ qua path lạ/junction.
                if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                    let cache_base = std::path::PathBuf::from(local_app_data).join("PrynX");
                    let current_cache = nuitka_cache_name_for_app_version(
                        &app.package_info().version.to_string(),
                    );
                    std::thread::spawn(move || {
                        match prune_sidecar_caches(&cache_base, current_cache.as_deref()) {
                            Ok((removed, failed)) => {
                                if !removed.is_empty() {
                                    log::info!("[SIDECAR-CACHE] Đã xóa: {}", removed.join(", "));
                                }
                                for error in failed {
                                    log::warn!("[SIDECAR-CACHE] Bỏ qua cache đang khóa: {}", error);
                                }
                            }
                            Err(error) => log::warn!("[SIDECAR-CACHE] Không thể prune: {}", error),
                        }
                    });
                }

                if let Err(error) = reveal_main_window(&app) {
                    log::error!("[STARTUP] {}", error);
                    startup_breadcrumb(&format!("setup complete: FAIL {error}"));
                    kill_sidecar();
                    std::process::exit(1);
                }
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

            // Limit concurrent tile renderings to prevent STATUS_STACK_BUFFER_OVERRUN and OOM
            static TILE_SEMAPHORE: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
            let sem = TILE_SEMAPHORE.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
            let sem_clone = sem.clone();

            tauri::async_runtime::spawn(async move {
                let _permit = match sem_clone.acquire().await {
                    Ok(p) => p,
                    Err(_) => return, // Semaphore closed
                };

                // Now we are allowed to use 1 thread from the OS blocking pool
                let res = tauri::async_runtime::spawn_blocking(move || {
                    let mut path = url.as_str();
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
                    if parts.len() < 7 {
                        return Err("Bad request".to_string());
                    }
                    let ch: Option<i32> = parts[0].parse().ok();
                    let cw: Option<i32> = parts[1].parse().ok();
                    let cy: Option<i32> = parts[2].parse().ok();
                    let cx: Option<i32> = parts[3].parse().ok();
                    let rot: i32 = parts[4].parse().unwrap_or(0);
                    let zoom: f32 = parts[5].parse().unwrap_or(1.0);
                    let page: i32 = parts[6].parse().unwrap_or(1);
                    let file_path_encoded = parts[7..].iter().rev().cloned().collect::<Vec<&str>>().join("/");
                    let file_path = urlencoding::decode(&file_path_encoded)
                        .unwrap_or_else(|_| file_path_encoded.clone().into())
                        .to_string();

                    let clip_x = cx.filter(|&v| v != 0 || cw.unwrap_or(0) != 0);
                    let clip_y = cy.filter(|&v| v != 0 || ch.unwrap_or(0) != 0);
                    let clip_w = cw.filter(|&v| v != 0);
                    let clip_h = ch.filter(|&v| v != 0);

                    render_tile_png(&file_path, page, zoom, rot, clip_x, clip_y, clip_w, clip_h)
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
            #[cfg(all(not(debug_assertions), target_os = "windows"))]
            if let tauri::RunEvent::Exit = _event {
                kill_sidecar();
            }
        });
}
