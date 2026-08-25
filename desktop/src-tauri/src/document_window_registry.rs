use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

use crate::{is_network_or_device_path, is_sensitive_path, lock_mutex};

const DOCUMENT_WINDOW_PREFIX: &str = "document-";
const SNAPSHOT_DIRECTORY: &str = "document-windows";
const SNAPSHOT_PREFIX: &str = "snapshot-";
const STAGING_PREFIX: &str = "prynx_print_new_window_";
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
const STAGING_GRANT_TTL: Duration = Duration::from_secs(2 * 60);
const DOCUMENT_WINDOW_READY_TIMEOUT: Duration = Duration::from_secs(20);
// UIUX (fix New Window 2026-08-25): mọi WebView2 dùng chung user-data directory
// phải có CÙNG environment arguments. Lệch với `tauri.conf.json` làm cửa sổ thứ
// hai chết bất đồng bộ bằng HRESULT 0x8007139F và Tauri không trả lỗi về invoke.
const SHARED_WEBVIEW_BROWSER_ARGS: &str = "--disable-features=msWebView2EnableDraggableRegions,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentWindowFitMode {
    Width,
    Page,
    Custom,
    Smart,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentWindowPageDisplayMode {
    SingleFit,
    SingleScroll,
    TwoFit,
    TwoScroll,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentWindowViewState {
    pub active_page: u32,
    pub zoom: f64,
    pub fit_mode: DocumentWindowFitMode,
    pub page_display_mode: DocumentWindowPageDisplayMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDocumentWindowRequest {
    pub document_session_id: String,
    pub file_name: String,
    pub document_title: String,
    pub source_path: String,
    pub view_state: DocumentWindowViewState,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWindowBootstrap {
    pub document_session_id: String,
    pub window_label: String,
    pub window_number: u32,
    pub file_name: String,
    pub document_title: String,
    pub snapshot_path: String,
    pub save_as_only: bool,
    pub view_state: DocumentWindowViewState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWindowCreated {
    pub window_label: String,
    pub window_number: u32,
}

struct PendingDocumentWindow {
    bootstrap: DocumentWindowBootstrap,
    created_at: Instant,
    ready_sender: Option<mpsc::Sender<()>>,
}

struct LiveDocumentWindow {
    document_session_id: String,
    window_number: u32,
    snapshot_path: PathBuf,
    ready_sender: Option<mpsc::Sender<()>>,
}

#[derive(Default)]
pub struct DocumentWindowRegistry {
    pending: HashMap<String, PendingDocumentWindow>,
    live: HashMap<String, LiveDocumentWindow>,
    staging_sources: HashMap<PathBuf, Instant>,
}

impl DocumentWindowRegistry {
    fn next_window_number(&self, document_session_id: &str) -> u32 {
        self.pending
            .values()
            .filter(|entry| entry.bootstrap.document_session_id == document_session_id)
            .map(|entry| entry.bootstrap.window_number)
            .chain(
                self.live
                    .values()
                    .filter(|entry| entry.document_session_id == document_session_id)
                    .map(|entry| entry.window_number),
            )
            .max()
            .map_or(2, |number| number.saturating_add(1).max(2))
    }

    fn insert_pending(
        &mut self,
        bootstrap: DocumentWindowBootstrap,
        ready_sender: Option<mpsc::Sender<()>>,
    ) {
        self.pending.insert(
            bootstrap.window_label.clone(),
            PendingDocumentWindow {
                bootstrap,
                created_at: Instant::now(),
                ready_sender,
            },
        );
    }

    fn take_for_window(&mut self, window_label: &str) -> Option<DocumentWindowBootstrap> {
        let PendingDocumentWindow {
            bootstrap,
            ready_sender,
            ..
        } = self.pending.remove(window_label)?;
        self.live.insert(
            window_label.to_string(),
            LiveDocumentWindow {
                document_session_id: bootstrap.document_session_id.clone(),
                window_number: bootstrap.window_number,
                snapshot_path: PathBuf::from(&bootstrap.snapshot_path),
                ready_sender,
            },
        );
        Some(bootstrap)
    }

    fn mark_window_ready(&mut self, window_label: &str) -> bool {
        self.live
            .get_mut(window_label)
            .and_then(|entry| entry.ready_sender.take())
            .is_some_and(|sender| sender.send(()).is_ok())
    }

    fn remove_window(&mut self, window_label: &str) -> Option<PathBuf> {
        if let Some(pending) = self.pending.remove(window_label) {
            return Some(PathBuf::from(pending.bootstrap.snapshot_path));
        }
        self.live
            .remove(window_label)
            .map(|entry| entry.snapshot_path)
    }

    fn prune_stale_pending(&mut self, now: Instant) -> Vec<PathBuf> {
        let labels = self
            .pending
            .iter()
            .filter_map(|(label, entry)| {
                (now.duration_since(entry.created_at) >= PENDING_TTL).then_some(label.clone())
            })
            .collect::<Vec<_>>();
        labels
            .into_iter()
            .filter_map(|label| self.remove_window(&label))
            .collect()
    }

    fn register_staging_source(&mut self, path: PathBuf, now: Instant) {
        self.staging_sources
            .retain(|_, created_at| now.saturating_duration_since(*created_at) < STAGING_GRANT_TTL);
        self.staging_sources.insert(path, now);
    }

    fn consume_staging_source(&mut self, path: &Path, now: Instant) -> bool {
        self.staging_sources
            .retain(|_, created_at| now.saturating_duration_since(*created_at) < STAGING_GRANT_TTL);
        self.staging_sources.remove(path).is_some()
    }
}

fn owned_staging_name(path: &Path) -> bool {
    let Some(nonce) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(STAGING_PREFIX))
        .and_then(|name| name.strip_suffix(".pdf"))
    else {
        return false;
    };
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn is_document_window_staging_path(path: &Path) -> bool {
    owned_staging_name(path)
}

fn canonical_owned_staging_path(path: &Path) -> Result<Option<PathBuf>, String> {
    if !owned_staging_name(path) {
        return Ok(None);
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Không tìm thấy file staging cho cửa sổ mới.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("File staging cho cửa sổ mới không an toàn.".to_string());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "Không chuẩn hóa được file staging cho cửa sổ mới.".to_string())?;
    let temp_directory = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "Không chuẩn hóa được thư mục tạm của PrynX.".to_string())?;
    if canonical.parent() != Some(temp_directory.as_path()) {
        return Ok(None);
    }
    let mut file = File::open(&canonical)
        .map_err(|_| "Không đọc được file staging cho cửa sổ mới.".to_string())?;
    let mut header = [0u8; 1024];
    let count = file
        .read(&mut header)
        .map_err(|_| "Không đọc được phần đầu file staging.".to_string())?;
    if !contains_pdf_header(&header[..count]) {
        return Err("File staging cho cửa sổ mới không có cấu trúc PDF hợp lệ.".to_string());
    }
    Ok(Some(canonical))
}

/// SEC (audit 2026-08-25 §NW.9): chỉ lệnh copy native vừa tạo đúng file staging
/// của New Window mới được phát hành quyền một lần; không allowlist cả `%TEMP%`.
pub fn register_document_window_staging(app: &AppHandle, path: &Path) -> Result<(), String> {
    let Some(canonical) = canonical_owned_staging_path(path)? else {
        return Ok(());
    };
    let registry = app
        .try_state::<Mutex<DocumentWindowRegistry>>()
        .ok_or_else(|| "Registry cửa sổ tài liệu chưa sẵn sàng.".to_string())?;
    lock_mutex(&registry).register_staging_source(canonical, Instant::now());
    Ok(())
}

fn consume_document_window_staging(app: &AppHandle, path: &Path) -> bool {
    let Some(registry) = app.try_state::<Mutex<DocumentWindowRegistry>>() else {
        return false;
    };
    let consumed = lock_mutex(&registry).consume_staging_source(path, Instant::now());
    consumed
}

fn snapshot_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join(SNAPSHOT_DIRECTORY))
        .map_err(|error| format!("Không xác định được thư mục cache PrynX: {error}"))
}

fn ensure_snapshot_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = snapshot_directory(app)?;
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Thư mục snapshot PDF của PrynX không an toàn.".to_string());
        }
        Ok(_) => return Ok(directory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("Không đọc được thư mục snapshot PrynX: {error}"));
        }
    }

    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Không tạo được thư mục snapshot PrynX: {error}"))?;
    let metadata = std::fs::symlink_metadata(&directory)
        .map_err(|error| format!("Không xác minh được thư mục snapshot PrynX: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Thư mục snapshot PDF của PrynX không an toàn.".to_string());
    }
    Ok(directory)
}

fn owned_snapshot_name(path: &Path) -> bool {
    let Some(nonce) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(SNAPSHOT_PREFIX))
        .and_then(|name| name.strip_suffix(".pdf"))
    else {
        return false;
    };
    nonce.len() == 32 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_remove_snapshot(app: &AppHandle, path: &Path) {
    let owned = snapshot_directory(app)
        .ok()
        .is_some_and(|directory| path.parent() == Some(directory.as_path()))
        && owned_snapshot_name(path);
    if !owned {
        log::warn!("[DOCUMENT-WINDOW] Từ chối xóa snapshot ngoài vùng sở hữu");
        return;
    }
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("[DOCUMENT-WINDOW] Không dọn được snapshot: {error}");
        }
    }
}

pub fn schedule_startup_cleanup(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(directory) = ensure_snapshot_directory(&app) else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(&directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_file()) && owned_snapshot_name(&path) {
                safe_remove_snapshot(&app, &path);
            }
        }
    });
}

fn new_nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn valid_document_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}

fn clean_display_text(value: &str, max_chars: usize) -> Option<String> {
    let cleaned = value.trim();
    if cleaned.is_empty()
        || cleaned.chars().count() > max_chars
        || cleaned.chars().any(char::is_control)
    {
        return None;
    }
    Some(cleaned.to_string())
}

fn valid_view_state(view: &DocumentWindowViewState) -> bool {
    (1..=10_000_000).contains(&view.active_page)
        && view.zoom.is_finite()
        && (0.01..=64.0).contains(&view.zoom)
}

fn contains_pdf_header(bytes: &[u8]) -> bool {
    bytes
        .get(..bytes.len().min(1024))
        .is_some_and(|head| head.windows(5).any(|window| window == b"%PDF-"))
}

fn canonical_document_path_text(path: &Path) -> Result<String, String> {
    let raw = path
        .to_str()
        .ok_or_else(|| "Đường dẫn PDF không dùng được trong cửa sổ mới.".to_string())?;
    #[cfg(target_os = "windows")]
    {
        if let Some(without_verbatim_prefix) = raw.strip_prefix(r"\\?\") {
            let bytes = without_verbatim_prefix.as_bytes();
            let is_drive_path = bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], 92 | b'/');
            if !is_drive_path {
                return Err("Không hỗ trợ PDF trên đường dẫn mạng hoặc thiết bị.".to_string());
            }
            return Ok(without_verbatim_prefix.to_string());
        }
    }
    let normalized = raw.to_ascii_lowercase();
    if is_network_or_device_path(raw)
        || normalized.starts_with(r"\??\")
        || normalized.starts_with(r"\device\")
    {
        return Err("Không hỗ trợ PDF trên đường dẫn mạng hoặc thiết bị.".to_string());
    }
    Ok(raw.to_string())
}

fn validate_pdf_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.len() > 32_767
        || is_network_or_device_path(path)
        || is_sensitive_path(path)
    {
        return Err("Đường dẫn PDF không được phép dùng cho cửa sổ mới.".to_string());
    }
    let source = Path::new(path);
    if !source.is_absolute() {
        return Err("Đường dẫn PDF phải là đường dẫn tuyệt đối.".to_string());
    }
    let metadata =
        std::fs::symlink_metadata(source).map_err(|_| "Không tìm thấy PDF đang mở.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Nguồn PDF phải là một file thường.".to_string());
    }
    let canonical = std::fs::canonicalize(source)
        .map_err(|_| "Không chuẩn hóa được đường dẫn PDF.".to_string())?;
    let scope_allowed = app.fs_scope().is_allowed(&canonical);
    let staging_allowed = consume_document_window_staging(app, &canonical);
    if !scope_allowed && !staging_allowed {
        return Err("PDF chưa được PrynX cấp quyền đọc cho cửa sổ mới.".to_string());
    }
    let canonical_text = canonical_document_path_text(&canonical)?;
    if is_sensitive_path(&canonical_text) {
        return Err("Đường dẫn PDF không được phép dùng cho cửa sổ mới.".to_string());
    }
    let extension_ok = Path::new(&canonical_text)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
    if !extension_ok {
        return Err("Cửa sổ mới chỉ hỗ trợ tài liệu PDF.".to_string());
    }
    let mut file = File::open(&canonical).map_err(|_| "Không đọc được PDF đang mở.".to_string())?;
    let mut header = [0u8; 1024];
    let count = file
        .read(&mut header)
        .map_err(|_| "Không đọc được phần đầu PDF.".to_string())?;
    if !contains_pdf_header(&header[..count]) {
        return Err("File đang mở không có cấu trúc PDF hợp lệ.".to_string());
    }
    Ok(canonical)
}

fn create_snapshot(app: &AppHandle, source_path: &str, nonce: &str) -> Result<PathBuf, String> {
    let source = validate_pdf_path(app, source_path)?;
    let directory = ensure_snapshot_directory(app)?;
    let snapshot_path = directory.join(format!("{SNAPSHOT_PREFIX}{nonce}.pdf"));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&snapshot_path)
        .map_err(|error| format!("Không tạo được snapshot PDF tạm: {error}"))?;
    let result = File::open(source)
        .map_err(|error| format!("Không mở được PDF đang làm việc: {error}"))
        .and_then(|mut input| {
            std::io::copy(&mut input, &mut output)
                .map(|_| ())
                .map_err(|error| format!("Không sao chép được PDF đang làm việc: {error}"))
        })
        .and_then(|_| {
            output
                .flush()
                .map_err(|error| format!("Không hoàn tất snapshot PDF tạm: {error}"))
        })
        .and_then(|_| {
            output
                .sync_all()
                .map_err(|error| format!("Không đồng bộ được snapshot PDF tạm: {error}"))
        });
    if let Err(error) = result {
        drop(output);
        safe_remove_snapshot(app, &snapshot_path);
        return Err(error);
    }
    Ok(snapshot_path)
}

fn validate_request(request: &CreateDocumentWindowRequest) -> Result<(String, String), String> {
    if !valid_document_session_id(&request.document_session_id) {
        return Err("Phiên tài liệu cho cửa sổ mới không hợp lệ.".to_string());
    }
    let file_name = clean_display_text(&request.file_name, 255)
        .ok_or_else(|| "Tên PDF cho cửa sổ mới không hợp lệ.".to_string())?;
    if !file_name.to_ascii_lowercase().ends_with(".pdf") {
        return Err("Cửa sổ mới chỉ hỗ trợ tài liệu PDF.".to_string());
    }
    let title = clean_display_text(&request.document_title, 255)
        .ok_or_else(|| "Tiêu đề cửa sổ mới không hợp lệ.".to_string())?;
    if !valid_view_state(&request.view_state) {
        return Err("Trạng thái hiển thị của cửa sổ mới không hợp lệ.".to_string());
    }
    Ok((file_name, title))
}

fn allowed_document_navigation(url: &tauri::Url) -> bool {
    let is_bundled_app =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none());
    if is_bundled_app {
        return true;
    }

    #[cfg(debug_assertions)]
    {
        return url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port() == Some(5173);
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

fn harden_document_webview(window: &WebviewWindow) {
    // SEC (audit 2026-08-25 §NW.3): cửa sổ động có cùng hardening với main.
    #[cfg(not(debug_assertions))]
    {
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
    #[cfg(target_os = "windows")]
    {
        let _ = window.with_webview(|webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows::core::Interface;
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2() {
                    if let Ok(settings) = core.Settings() {
                        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                        }
                    }
                }
            }
        });
    }
}

#[tauri::command]
pub async fn create_document_window(
    app: AppHandle,
    source_window: WebviewWindow,
    request: CreateDocumentWindowRequest,
) -> Result<DocumentWindowCreated, String> {
    let source_label = source_window.label();
    if source_label != "main" && !source_label.starts_with(DOCUMENT_WINDOW_PREFIX) {
        return Err("Cửa sổ hiện tại không được phép nhân bản tài liệu.".to_string());
    }
    let (file_name, document_title) = validate_request(&request)?;
    let nonce = new_nonce();
    let window_label = format!("{DOCUMENT_WINDOW_PREFIX}{nonce}");

    // PERF/SEC (audit 2026-08-25 §NW.3): PDF lớn chỉ đi bằng path đã được
    // fs_scope cấp; toàn bộ I/O chạy ngoài async runtime/IPC thread.
    let snapshot_app = app.clone();
    let source_path = request.source_path.clone();
    let snapshot_nonce = nonce.clone();
    let snapshot_path = tauri::async_runtime::spawn_blocking(move || {
        create_snapshot(&snapshot_app, &source_path, &snapshot_nonce)
    })
    .await
    .map_err(|error| format!("Không hoàn tất tác vụ tạo snapshot PDF: {error}"))??;

    let snapshot_path_text = match snapshot_path.to_str() {
        Some(path) => path.to_string(),
        None => {
            safe_remove_snapshot(&app, &snapshot_path);
            return Err("Đường dẫn snapshot PDF không biểu diễn được bằng Unicode.".to_string());
        }
    };

    let registry = app.state::<Mutex<DocumentWindowRegistry>>();
    let (window_number, stale_paths, ready_receiver) = {
        let mut state = lock_mutex(&registry);
        let stale_paths = state.prune_stale_pending(Instant::now());
        let window_number = state.next_window_number(&request.document_session_id);
        let (ready_sender, ready_receiver) = mpsc::channel();
        state.insert_pending(
            DocumentWindowBootstrap {
                document_session_id: request.document_session_id.clone(),
                window_label: window_label.clone(),
                window_number,
                file_name: file_name.clone(),
                document_title: document_title.clone(),
                snapshot_path: snapshot_path_text,
                save_as_only: true,
                view_state: request.view_state.clone(),
            },
            Some(ready_sender),
        );
        (window_number, stale_paths, ready_receiver)
    };
    for path in stale_paths {
        safe_remove_snapshot(&app, &path);
    }

    let scale = source_window.scale_factor().unwrap_or(1.0).max(0.1);
    let size = source_window.inner_size().ok();
    let position = source_window.outer_position().ok();
    let mut builder =
        WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App("index.html".into()))
            .title(format!("{document_title}:{window_number} — PrynX"))
            .min_inner_size(900.0, 600.0)
            .resizable(true)
            .fullscreen(false)
            .decorations(false)
            .transparent(true)
            .prevent_overflow()
            .visible(false)
            .focused(false)
            .on_navigation(allowed_document_navigation)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .additional_browser_args(SHARED_WEBVIEW_BROWSER_ARGS);
    if let Some(size) = size {
        builder = builder.inner_size(size.width as f64 / scale, size.height as f64 / scale);
    }
    if let Some(position) = position {
        builder = builder.position(position.x as f64 / scale, position.y as f64 / scale);
    }
    #[cfg(not(debug_assertions))]
    {
        builder = builder.devtools(false);
    }

    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            if let Some(path) = lock_mutex(&registry).remove_window(&window_label) {
                safe_remove_snapshot(&app, &path);
            }
            return Err(format!("Không tạo được cửa sổ PDF mới: {error}"));
        }
    };
    harden_document_webview(&window);

    // UIUX (fix New Window 2026-08-25): WebView2 có thể trả `Ok(window)` rồi mới
    // báo lỗi khởi tạo bất đồng bộ. Chỉ báo thành công cho cửa sổ gọi sau khi child
    // đã lấy bootstrap và tự hiện; nhờ đó lỗi không còn biến thành một cú bấm im lặng.
    let readiness = tauri::async_runtime::spawn_blocking(move || {
        ready_receiver.recv_timeout(DOCUMENT_WINDOW_READY_TIMEOUT)
    })
    .await;
    let readiness_error = match readiness {
        Ok(Ok(())) => {
            return Ok(DocumentWindowCreated {
                window_label,
                window_number,
            });
        }
        Ok(Err(mpsc::RecvTimeoutError::Timeout)) => {
            "Cửa sổ PDF mới không phản hồi sau 20 giây. Hãy thử lại; nếu lỗi lặp lại, hãy khởi động lại PrynX."
                .to_string()
        }
        Ok(Err(mpsc::RecvTimeoutError::Disconnected)) => {
            "Cửa sổ PDF mới đã đóng trước khi sẵn sàng. Hãy thử mở lại.".to_string()
        }
        Err(error) => format!("Không theo dõi được trạng thái cửa sổ PDF mới: {error}"),
    };

    // Xóa registry trước để một tín hiệu ready đến muộn không thể hiện zombie window.
    let snapshot_path = lock_mutex(&registry).remove_window(&window_label);
    if let Err(error) = window.destroy() {
        log::warn!(
            "[DOCUMENT-WINDOW] Không hủy được cửa sổ lỗi {}: {}",
            window_label,
            error
        );
    }
    if let Some(path) = snapshot_path {
        safe_remove_snapshot(&app, &path);
    }
    Err(readiness_error)
}

#[tauri::command]
pub fn take_document_window_bootstrap(
    window: WebviewWindow,
    registry: State<'_, Mutex<DocumentWindowRegistry>>,
) -> Result<DocumentWindowBootstrap, String> {
    let label = window.label();
    if !label.starts_with(DOCUMENT_WINDOW_PREFIX) {
        return Err("Bootstrap cửa sổ tài liệu chỉ dành cho cửa sổ phụ.".to_string());
    }
    lock_mutex(&registry)
        .take_for_window(label)
        .ok_or_else(|| "Bootstrap cửa sổ tài liệu đã hết hạn hoặc đã được dùng.".to_string())
}

#[tauri::command]
pub fn show_document_window_ready(
    window: WebviewWindow,
    registry: State<'_, Mutex<DocumentWindowRegistry>>,
) -> Result<(), String> {
    let label = window.label();
    if !label.starts_with(DOCUMENT_WINDOW_PREFIX) {
        return Err("Chỉ cửa sổ tài liệu mới được dùng lệnh hiển thị này.".to_string());
    }
    if !lock_mutex(&registry).live.contains_key(label) {
        return Err(
            "Cửa sổ tài liệu chưa nhận bootstrap hợp lệ nên không thể hiển thị.".to_string(),
        );
    }
    window
        .show()
        .map_err(|error| format!("Không hiện được cửa sổ tài liệu: {error}"))?;
    if !lock_mutex(&registry).mark_window_ready(label) {
        let _ = window.destroy();
        return Err("Cửa sổ PDF đã quá hạn hoặc tín hiệu sẵn sàng đã được dùng.".to_string());
    }
    if let Err(error) = window.set_focus() {
        // Cửa sổ đã nhìn thấy được; lỗi giành focus không được biến thành lỗi mở cửa sổ.
        log::warn!(
            "[DOCUMENT-WINDOW] Cửa sổ {} đã hiện nhưng không focus được: {}",
            label,
            error
        );
    }
    Ok(())
}

pub fn handle_window_destroyed(app: &AppHandle, window_label: &str) {
    if !window_label.starts_with(DOCUMENT_WINDOW_PREFIX) {
        return;
    }
    let Some(registry) = app.try_state::<Mutex<DocumentWindowRegistry>>() else {
        return;
    };
    let snapshot_path = { lock_mutex(&registry).remove_window(window_label) };
    if let Some(path) = snapshot_path {
        safe_remove_snapshot(app, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bootstrap(label: &str, document: &str, number: u32) -> DocumentWindowBootstrap {
        DocumentWindowBootstrap {
            document_session_id: document.to_string(),
            window_label: label.to_string(),
            window_number: number,
            file_name: "menu.pdf".to_string(),
            document_title: "menu.pdf".to_string(),
            snapshot_path: std::env::temp_dir()
                .join(format!("{SNAPSHOT_PREFIX}{label}.pdf"))
                .to_string_lossy()
                .into_owned(),
            save_as_only: true,
            view_state: DocumentWindowViewState {
                active_page: 3,
                zoom: 1.25,
                fit_mode: DocumentWindowFitMode::Custom,
                page_display_mode: DocumentWindowPageDisplayMode::SingleScroll,
            },
        }
    }

    #[test]
    fn bootstrap_chi_duoc_lay_mot_lan_va_chuyen_sang_live() {
        let mut registry = DocumentWindowRegistry::default();
        registry.insert_pending(bootstrap("document-a", "main:tab-a", 2), None);
        assert!(registry.take_for_window("document-a").is_some());
        assert!(registry.take_for_window("document-a").is_none());
        assert!(registry.live.contains_key("document-a"));
    }

    #[test]
    fn danh_so_cua_so_doc_lap_theo_tai_lieu() {
        let mut registry = DocumentWindowRegistry::default();
        assert_eq!(registry.next_window_number("main:tab-a"), 2);
        registry.insert_pending(bootstrap("document-a", "main:tab-a", 2), None);
        assert_eq!(registry.next_window_number("main:tab-a"), 3);
        assert_eq!(registry.next_window_number("main:tab-b"), 2);
    }

    #[test]
    fn ready_signal_di_theo_bootstrap_va_chi_phat_mot_lan() {
        let (sender, receiver) = mpsc::channel();
        let mut registry = DocumentWindowRegistry::default();
        registry.insert_pending(bootstrap("document-a", "main:tab-a", 2), Some(sender));

        assert!(!registry.mark_window_ready("document-a"));
        assert!(registry.take_for_window("document-a").is_some());
        assert!(registry.mark_window_ready("document-a"));
        assert_eq!(receiver.recv_timeout(Duration::from_millis(50)), Ok(()));
        assert!(!registry.mark_window_ready("document-a"));
    }

    #[test]
    fn xoa_cua_so_truoc_ready_lam_receiver_ngat_ket_noi() {
        let (sender, receiver) = mpsc::channel();
        let mut registry = DocumentWindowRegistry::default();
        registry.insert_pending(bootstrap("document-a", "main:tab-a", 2), Some(sender));

        assert!(registry.remove_window("document-a").is_some());
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn xoa_live_window_truoc_ready_lam_receiver_ngat_ket_noi() {
        let (sender, receiver) = mpsc::channel();
        let mut registry = DocumentWindowRegistry::default();
        registry.insert_pending(bootstrap("document-a", "main:tab-a", 2), Some(sender));
        assert!(registry.take_for_window("document-a").is_some());

        assert!(registry.remove_window("document-a").is_some());
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn browser_args_cua_child_khop_chinh_xac_voi_main_window() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap();
        assert_eq!(
            main["additionalBrowserArgs"].as_str(),
            Some(SHARED_WEBVIEW_BROWSER_ARGS)
        );
    }

    #[test]
    fn validation_tu_choi_session_va_view_state_khong_hop_le() {
        assert!(valid_document_session_id("main:imposition-123"));
        assert!(!valid_document_session_id("../../escape"));
        assert!(!valid_view_state(&DocumentWindowViewState {
            active_page: 0,
            zoom: f64::NAN,
            fit_mode: DocumentWindowFitMode::Page,
            page_display_mode: DocumentWindowPageDisplayMode::SingleFit,
        }));
    }

    #[test]
    fn chi_nhan_pdf_header_trong_1k_dau() {
        assert!(contains_pdf_header(b"%PDF-1.7\nbody"));
        assert!(contains_pdf_header(b"comment\n%PDF-2.0\nbody"));
        assert!(!contains_pdf_header(b"not a pdf"));
    }

    #[test]
    fn chi_cho_phep_dieu_huong_vao_origin_cua_prynx() {
        assert!(allowed_document_navigation(
            &tauri::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(allowed_document_navigation(
            &tauri::Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(!allowed_document_navigation(
            &tauri::Url::parse("http://localhost:8321/docs").unwrap()
        ));
        assert!(!allowed_document_navigation(
            &tauri::Url::parse("https://example.com/").unwrap()
        ));
        #[cfg(debug_assertions)]
        assert!(allowed_document_navigation(
            &tauri::Url::parse("http://localhost:5173/").unwrap()
        ));
    }

    #[test]
    fn ten_staging_chi_nhan_nonce_hex_thuong_128_bit() {
        assert!(owned_staging_name(Path::new(
            "prynx_print_new_window_0123456789abcdef0123456789abcdef.pdf"
        )));
        for invalid in [
            "prynx_print_new_window_0123456789abcdef0123456789abcde.pdf",
            "prynx_print_new_window_0123456789abcdef0123456789abcdef0.pdf",
            "prynx_print_new_window_0123456789abcdef0123456789abcdeg.pdf",
            "prynx_print_new_window_0123456789ABCDEF0123456789ABCDEF.pdf",
            "prynx_print_new_window_0123456789abcdef0123456789abcdef.pdf.tmp",
            "prynx_print_0123456789abcdef0123456789abcdef.pdf",
        ] {
            assert!(!owned_staging_name(Path::new(invalid)), "{invalid}");
        }
    }

    #[test]
    fn staging_phai_la_file_con_truc_tiep_cua_temp() {
        let temp_directory = std::env::temp_dir();
        let direct = temp_directory.join(format!("{STAGING_PREFIX}{}.pdf", new_nonce()));
        std::fs::write(&direct, b"%PDF-1.7\n").unwrap();
        let accepted = canonical_owned_staging_path(&direct).unwrap().unwrap();
        assert_eq!(
            accepted.parent(),
            temp_directory.canonicalize().ok().as_deref()
        );
        std::fs::remove_file(&direct).unwrap();

        let nested_directory = temp_directory.join(format!("prynx-window-test-{}", new_nonce()));
        std::fs::create_dir(&nested_directory).unwrap();
        let nested = nested_directory.join(format!("{STAGING_PREFIX}{}.pdf", new_nonce()));
        std::fs::write(&nested, b"%PDF-1.7\n").unwrap();
        assert!(canonical_owned_staging_path(&nested).unwrap().is_none());
        std::fs::remove_file(&nested).unwrap();
        std::fs::remove_dir(&nested_directory).unwrap();
    }

    #[test]
    fn staging_tu_choi_file_khong_co_pdf_header() {
        let path = std::env::temp_dir().join(format!("{STAGING_PREFIX}{}.pdf", new_nonce()));
        std::fs::write(&path, b"khong-phai-pdf").unwrap();
        assert!(canonical_owned_staging_path(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn grant_staging_chi_duoc_dung_mot_lan_va_co_han() {
        let now = Instant::now();
        let path = PathBuf::from("staging.pdf");
        let mut registry = DocumentWindowRegistry::default();
        registry.register_staging_source(path.clone(), now);
        assert!(registry.consume_staging_source(&path, now));
        assert!(!registry.consume_staging_source(&path, now));

        let expired_at = now
            .checked_sub(STAGING_GRANT_TTL + Duration::from_secs(1))
            .unwrap();
        registry.register_staging_source(path.clone(), expired_at);
        assert!(!registry.consume_staging_source(&path, now));
    }
}
