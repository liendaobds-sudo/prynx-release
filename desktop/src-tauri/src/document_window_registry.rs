use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use crate::{
    disk_compare_key, is_network_or_device_path, is_sensitive_path, is_sensitive_write_path,
    lock_mutex, windows_file_identity, windows_file_identity_from_handle, WindowsFileIdentity,
};

const DOCUMENT_WINDOW_PREFIX: &str = "document-";
const SNAPSHOT_DIRECTORY: &str = "document-windows";
const SNAPSHOT_PREFIX: &str = "snapshot-";
const STAGING_PREFIX: &str = "prynx_print_new_window_";
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
const STAGING_GRANT_TTL: Duration = Duration::from_secs(2 * 60);
const SAVE_GRANT_TTL: Duration = Duration::from_secs(2 * 60);
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSaveDialogRequest {
    pub suggested_name: String,
    pub title: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSaveSelection {
    pub path: String,
    pub grant: String,
}

struct PendingDocumentWindow {
    bootstrap: DocumentWindowBootstrap,
    // SEC (audit 2026-09-04 §SEC.15): chỉ native giữ lineage nguồn/snapshot;
    // tuyệt đối không serialize danh sách này sang renderer không tin cậy.
    protected_sources: Vec<ProtectedSource>,
    created_at: Instant,
    ready_sender: Option<mpsc::Sender<()>>,
}

struct LiveDocumentWindow {
    document_session_id: String,
    window_number: u32,
    snapshot_path: PathBuf,
    protected_sources: Vec<ProtectedSource>,
    ready_sender: Option<mpsc::Sender<()>>,
}

struct StagingSourceGrant {
    created_at: Instant,
    protected_sources: Vec<ProtectedSource>,
}

struct DocumentSaveGrant {
    window_label: String,
    target_binding: SaveTargetBinding,
    #[cfg(windows)]
    locked_protected_sources: Vec<LockedProtectedSource>,
    created_at: Instant,
}

#[derive(Debug, Default)]
struct ConsumedSaveGrant {
    #[cfg(windows)]
    locked_protected_sources: Vec<LockedProtectedSource>,
}

/// SEC (audit 2026-09-04 §SEC.15): mỗi source được bảo vệ bằng cả tên lexical
/// lẫn định danh file ổn định. Tên cũ vẫn chặn file thay thế tại cùng vị trí;
/// định danh vẫn theo được file gốc sau khi nó bị đổi tên.
#[derive(Clone, Debug)]
struct ProtectedSource {
    lexical_path: PathBuf,
    file_identity: Option<WindowsFileIdentity>,
}

impl ProtectedSource {
    fn capture(lexical_path: PathBuf) -> Self {
        let file_identity = windows_file_identity(&lexical_path);
        Self {
            lexical_path,
            file_identity,
        }
    }

    fn conflicts_with(&self, target: &Path) -> Result<bool, String> {
        self.conflicts_with_observation(
            target,
            std::fs::symlink_metadata(target).is_ok(),
            windows_file_identity(target),
        )
    }

    fn conflicts_with_observation(
        &self,
        target: &Path,
        target_exists: bool,
        target_identity: Option<WindowsFileIdentity>,
    ) -> Result<bool, String> {
        let protected_key = disk_compare_key(&self.lexical_path);
        if !protected_key.is_empty() && protected_key == disk_compare_key(target) {
            return Ok(true);
        }
        if self
            .file_identity
            .zip(target_identity)
            .is_some_and(|(protected, current)| protected == current)
        {
            return Ok(true);
        }
        #[cfg(windows)]
        if target_exists && (self.file_identity.is_none() || target_identity.is_none()) {
            // Một process có thể cố ý mở target với share mode khắt khe để oracle
            // định danh thất bại. Không được biến `None` thành quyền ghi đè.
            return Err(
                "Không xác minh được định danh file đích so với nguồn được bảo vệ.".to_string(),
            );
        }
        Ok(false)
    }
}

/// Parent đã canonicalize nhưng tên file giữ nguyên đúng từng ký tự mà hộp thoại
/// native trả về. Vì vậy renderer không thể đổi riêng hoa/thường rồi dùng lại grant.
#[derive(Clone, Debug, Eq, PartialEq)]
struct SaveTargetBinding {
    canonical_parent: PathBuf,
    canonical_parent_identity: Option<WindowsFileIdentity>,
    exact_file_name: OsString,
}

impl SaveTargetBinding {
    fn target_path(&self) -> PathBuf {
        self.canonical_parent.join(&self.exact_file_name)
    }
}

#[cfg(windows)]
struct LockedSaveDirectory {
    path: PathBuf,
    identity: WindowsFileIdentity,
    _handle: File,
}

#[cfg(windows)]
#[derive(Debug)]
struct LockedProtectedSource {
    identity: WindowsFileIdentity,
    handle: File,
}

/// Lease RAII giữ handle không chia sẻ quyền DELETE trên toàn bộ chuỗi thư mục
/// đích. Khi lease còn sống, junction/rename không thể tráo nghĩa của path giữa
/// lúc tiêu grant và lúc publish file tạm.
pub struct SaveTargetLease {
    target_path: PathBuf,
    canonical_parent: PathBuf,
    #[cfg(windows)]
    locked_directories: Vec<LockedSaveDirectory>,
    #[cfg(windows)]
    locked_protected_sources: Vec<LockedProtectedSource>,
}

impl SaveTargetLease {
    pub fn target(&self) -> &Path {
        &self.target_path
    }

    pub fn verify(&self) -> Result<(), String> {
        let current_parent = std::fs::canonicalize(&self.canonical_parent)
            .map_err(|_| "Thư mục lưu PDF đã thay đổi trong lúc ghi.".to_string())?;
        if current_parent != self.canonical_parent {
            return Err("Thư mục lưu PDF đã đổi định danh trong lúc ghi.".to_string());
        }
        reject_reparse_components(&self.canonical_parent)?;

        #[cfg(windows)]
        for locked in &self.locked_directories {
            if windows_file_identity(&locked.path) != Some(locked.identity) {
                return Err("Chuỗi thư mục lưu PDF đã thay đổi trong lúc ghi.".to_string());
            }
        }
        #[cfg(windows)]
        for locked in &self.locked_protected_sources {
            if windows_file_identity_from_handle(&locked.handle) != Some(locked.identity) {
                return Err("Handle nguồn được bảo vệ không còn đúng định danh.".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct DocumentWindowRegistry {
    pending: HashMap<String, PendingDocumentWindow>,
    live: HashMap<String, LiveDocumentWindow>,
    staging_sources: HashMap<PathBuf, StagingSourceGrant>,
    save_grants: HashMap<String, DocumentSaveGrant>,
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
        protected_sources: Vec<ProtectedSource>,
        ready_sender: Option<mpsc::Sender<()>>,
    ) {
        self.pending.insert(
            bootstrap.window_label.clone(),
            PendingDocumentWindow {
                bootstrap,
                protected_sources,
                created_at: Instant::now(),
                ready_sender,
            },
        );
    }

    fn take_for_window(&mut self, window_label: &str) -> Option<DocumentWindowBootstrap> {
        let PendingDocumentWindow {
            bootstrap,
            protected_sources,
            ready_sender,
            ..
        } = self.pending.remove(window_label)?;
        self.live.insert(
            window_label.to_string(),
            LiveDocumentWindow {
                document_session_id: bootstrap.document_session_id.clone(),
                window_number: bootstrap.window_number,
                snapshot_path: PathBuf::from(&bootstrap.snapshot_path),
                protected_sources,
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
        // Vé Save As gắn với vòng đời chính cửa sổ; destroy phải vô hiệu ngay, không
        // chờ TTL và không cho WebView khác nhặt lại nonce.
        self.save_grants
            .retain(|_, grant| grant.window_label != window_label);
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

    fn register_staging_source(
        &mut self,
        path: PathBuf,
        protected_sources: Vec<ProtectedSource>,
        now: Instant,
    ) {
        self.staging_sources
            .retain(|_, grant| now.saturating_duration_since(grant.created_at) < STAGING_GRANT_TTL);
        self.staging_sources.insert(
            path,
            StagingSourceGrant {
                created_at: now,
                protected_sources,
            },
        );
    }

    fn consume_staging_source(
        &mut self,
        path: &Path,
        now: Instant,
    ) -> Option<Vec<ProtectedSource>> {
        self.staging_sources
            .retain(|_, grant| now.saturating_duration_since(grant.created_at) < STAGING_GRANT_TTL);
        self.staging_sources
            .remove(path)
            .map(|grant| grant.protected_sources)
    }

    fn protected_sources_for_child(
        &self,
        window_label: &str,
        document_session_id: &str,
    ) -> Result<Vec<ProtectedSource>, String> {
        let entry = self
            .live
            .get(window_label)
            .ok_or_else(|| "Cửa sổ tài liệu không còn hiệu lực.".to_string())?;
        if entry.document_session_id != document_session_id {
            return Err("Phiên tài liệu của cửa sổ con không khớp cửa sổ cha.".to_string());
        }
        Ok(entry.protected_sources.clone())
    }

    fn staging_lineage_for_caller(
        &self,
        window_label: &str,
        canonical_source: &Path,
        scope_allowed: bool,
    ) -> Result<Vec<ProtectedSource>, String> {
        let mut lineage = if window_label == "main" {
            if !scope_allowed {
                return Err(
                    "PDF nguồn chưa được người dùng cấp quyền cho cửa sổ mới (chọn qua hộp thoại hoặc kéo-thả)."
                        .to_string(),
                );
            }
            Vec::new()
        } else if window_label.starts_with(DOCUMENT_WINDOW_PREFIX) {
            let entry = self
                .live
                .get(window_label)
                .ok_or_else(|| "Cửa sổ tài liệu không còn hiệu lực.".to_string())?;
            if !scope_allowed
                && !protected_sources_conflict(&entry.protected_sources, canonical_source)?
            {
                return Err(
                    "PDF nguồn không thuộc lineage đã được native cấp cho cửa sổ tài liệu."
                        .to_string(),
                );
            }
            entry.protected_sources.clone()
        } else {
            return Err("Cửa sổ hiện tại không được phép tạo staging PDF.".to_string());
        };
        push_protected_path(&mut lineage, canonical_source.to_path_buf());
        Ok(lineage)
    }

    fn issue_save_grant(
        &mut self,
        window_label: &str,
        selected_target: PathBuf,
        now: Instant,
    ) -> Result<String, String> {
        let target_binding = canonical_save_target(&selected_target)?;
        // Thả handle của grant đã hết hạn trước khi xin khóa mới; nếu làm sau,
        // sharing contract của chính grant cũ sẽ khiến lượt Save As kế tiếp tự khóa.
        self.save_grants
            .retain(|_, grant| now.saturating_duration_since(grant.created_at) < SAVE_GRANT_TTL);
        let protected = self
            .live
            .get(window_label)
            .ok_or_else(|| "Cửa sổ tài liệu không còn hiệu lực.".to_string())?
            .protected_sources
            .clone();
        // SEC (audit 2026-09-04 §SEC.15-R2): khóa identity nguồn ngay lúc cấp
        // grant. Nếu kiểm path trước rồi mới mở handle, attacker còn một cửa sổ để
        // rename nguồn vào đúng target đã chọn và chờ sink ghi đè.
        #[cfg(windows)]
        let locked_protected_sources = lock_protected_sources(&protected)?;
        reject_protected_target(&protected, &target_binding.target_path())?;
        let grant = loop {
            let candidate = new_nonce();
            if !self.save_grants.contains_key(&candidate) {
                break candidate;
            }
        };
        self.save_grants.insert(
            grant.clone(),
            DocumentSaveGrant {
                window_label: window_label.to_string(),
                target_binding,
                #[cfg(windows)]
                locked_protected_sources,
                created_at: now,
            },
        );
        Ok(grant)
    }

    fn consume_save_grant(
        &mut self,
        window_label: &str,
        target_binding: &SaveTargetBinding,
        grant: &str,
        now: Instant,
    ) -> Result<ConsumedSaveGrant, String> {
        self.save_grants
            .retain(|_, entry| now.saturating_duration_since(entry.created_at) < SAVE_GRANT_TTL);
        // Xóa trước khi so label/path để token đúng luôn one-shot, kể cả renderer cố
        // dùng sai sink hay sai cửa sổ rồi phát lại.
        let entry = self
            .save_grants
            .remove(grant)
            .ok_or_else(|| "Vé lưu file đã hết hạn, không hợp lệ hoặc đã được dùng.".to_string())?;
        if entry.window_label != window_label {
            return Err("Vé lưu file không thuộc cửa sổ hiện tại.".to_string());
        }
        if entry.target_binding != *target_binding {
            return Err("Đích lưu không khớp vị trí đã chọn trong hộp thoại native.".to_string());
        }
        let protected = self
            .live
            .get(window_label)
            .ok_or_else(|| "Cửa sổ tài liệu không còn hiệu lực.".to_string())?
            .protected_sources
            .clone();
        // TOCTOU: target có thể bị đổi thành hardlink/junction sau khi hộp thoại đóng;
        // sink phải kiểm lại định danh file ngay trước I/O.
        reject_protected_target(&protected, &target_binding.target_path())?;
        Ok(ConsumedSaveGrant {
            #[cfg(windows)]
            locked_protected_sources: entry.locked_protected_sources,
        })
    }

    fn expire_save_grant(&mut self, grant: &str, now: Instant) -> bool {
        let is_expired = self
            .save_grants
            .get(grant)
            .is_some_and(|entry| now.saturating_duration_since(entry.created_at) >= SAVE_GRANT_TTL);
        if !is_expired {
            return false;
        }

        // SEC (audit 2026-09-04 §SEC.15-R2): grant giữ handle không share DELETE
        // ngay từ lúc hộp thoại trả về. Phải tự thả handle đúng TTL kể cả renderer
        // bỏ luôn sink, nếu không source có thể bị khóa tới khi đóng cửa sổ.
        self.save_grants.remove(grant).is_some()
    }
}

fn push_protected_path(paths: &mut Vec<ProtectedSource>, candidate: PathBuf) {
    push_protected_source(paths, ProtectedSource::capture(candidate));
}

fn push_protected_source(paths: &mut Vec<ProtectedSource>, candidate: ProtectedSource) {
    let candidate_path = &candidate.lexical_path;
    let candidate_key = disk_compare_key(candidate_path);
    if !paths.iter().any(|existing| {
        !candidate_key.is_empty() && disk_compare_key(&existing.lexical_path) == candidate_key
    }) {
        paths.push(candidate);
    }
}

fn reject_protected_target(protected: &[ProtectedSource], target: &Path) -> Result<(), String> {
    if protected_sources_conflict(protected, target)? {
        return Err(
            "Cửa sổ tài liệu chỉ được Lưu thành file mới; không được ghi đè nguồn hoặc snapshot."
                .to_string(),
        );
    }
    Ok(())
}

fn protected_sources_conflict(
    protected: &[ProtectedSource],
    target: &Path,
) -> Result<bool, String> {
    for source in protected {
        if source.conflicts_with(target)? {
            return Ok(true);
        }
    }
    Ok(false)
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

/// Kiểm ngoại lệ staging app-owned trước khi copy. Chỉ đúng tên nonce 128-bit,
/// file con trực tiếp của `%TEMP%` và chưa tồn tại mới được bỏ qua save grant.
pub fn validate_document_window_staging_target(path: &Path) -> Result<Option<PathBuf>, String> {
    if !owned_staging_name(path) {
        return Ok(None);
    }
    if !path.is_absolute() {
        return Err("Đường dẫn staging cho cửa sổ mới phải là tuyệt đối.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Đường dẫn staging không có thư mục cha.".to_string())?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|_| "Không chuẩn hóa được thư mục staging.".to_string())?;
    let canonical_temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "Không chuẩn hóa được thư mục tạm của PrynX.".to_string())?;
    if canonical_parent != canonical_temp {
        return Err("File staging phải nằm trực tiếp trong thư mục tạm của PrynX.".to_string());
    }
    if std::fs::symlink_metadata(path).is_ok() {
        return Err("File staging cho cửa sổ mới đã tồn tại.".to_string());
    }
    Ok(Some(canonical_parent.join(path.file_name().ok_or_else(
        || "Đường dẫn staging không có tên file.".to_string(),
    )?)))
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

/// SEC (audit 2026-08-25 §NW.9; 2026-09-04 §SEC.15): kiểm nguồn TRƯỚC khi
/// `copy_file_atomic` tạo staging. Main vẫn phải có `fs_scope`; child chỉ được dùng
/// source thuộc lineage native của chính nó (hoặc path đã được picker/drop cấp scope).
pub fn validate_document_window_staging_source(
    app: &AppHandle,
    window_label: &str,
    source: &Path,
) -> Result<(), String> {
    let canonical_source = std::fs::canonicalize(source)
        .map_err(|_| "Không chuẩn hóa được đường dẫn PDF nguồn".to_string())?;
    let scope_allowed = app.fs_scope().is_allowed(&canonical_source);
    let registry = app
        .try_state::<Mutex<DocumentWindowRegistry>>()
        .ok_or_else(|| "Registry cửa sổ tài liệu chưa sẵn sàng.".to_string())?;
    let result = lock_mutex(&registry)
        .staging_lineage_for_caller(window_label, &canonical_source, scope_allowed)
        .map(|_| ());
    result
}

/// Chỉ lệnh copy native vừa tạo đúng file staging của New Window mới phát hành
/// quyền một lần; grant mang lineage nguồn nhưng không bao giờ đưa lineage ra renderer.
pub fn register_document_window_staging(
    app: &AppHandle,
    window_label: &str,
    source: &Path,
    path: &Path,
) -> Result<(), String> {
    let Some(canonical) = canonical_owned_staging_path(path)? else {
        return Ok(());
    };
    let canonical_source = std::fs::canonicalize(source)
        .map_err(|_| "Không chuẩn hóa được đường dẫn PDF nguồn".to_string())?;
    let scope_allowed = app.fs_scope().is_allowed(&canonical_source);
    let registry = app
        .try_state::<Mutex<DocumentWindowRegistry>>()
        .ok_or_else(|| "Registry cửa sổ tài liệu chưa sẵn sàng.".to_string())?;
    let mut state = lock_mutex(&registry);
    let lineage =
        state.staging_lineage_for_caller(window_label, &canonical_source, scope_allowed)?;
    state.register_staging_source(canonical, lineage, Instant::now());
    Ok(())
}

fn consume_document_window_staging(app: &AppHandle, path: &Path) -> Option<Vec<ProtectedSource>> {
    let Some(registry) = app.try_state::<Mutex<DocumentWindowRegistry>>() else {
        return None;
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

struct ValidatedPdfSource {
    canonical_path: PathBuf,
    staging_lineage: Vec<ProtectedSource>,
}

fn validate_pdf_path(app: &AppHandle, path: &str) -> Result<ValidatedPdfSource, String> {
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
    let staging_lineage = consume_document_window_staging(app, &canonical);
    if !scope_allowed && staging_lineage.is_none() {
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
    Ok(ValidatedPdfSource {
        canonical_path: canonical,
        staging_lineage: staging_lineage.unwrap_or_default(),
    })
}

fn create_snapshot(
    app: &AppHandle,
    source_path: &str,
    nonce: &str,
) -> Result<(PathBuf, PathBuf, Vec<ProtectedSource>), String> {
    let source = validate_pdf_path(app, source_path)?;
    let directory = ensure_snapshot_directory(app)?;
    let snapshot_path = directory.join(format!("{SNAPSHOT_PREFIX}{nonce}.pdf"));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&snapshot_path)
        .map_err(|error| format!("Không tạo được snapshot PDF tạm: {error}"))?;
    let result = File::open(&source.canonical_path)
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
    Ok((snapshot_path, source.canonical_path, source.staging_lineage))
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

fn validate_save_dialog_request(
    request: &DocumentSaveDialogRequest,
) -> Result<(String, String), String> {
    let suggested_name = clean_display_text(&request.suggested_name, 255)
        .ok_or_else(|| "Tên PDF gợi ý không hợp lệ.".to_string())?;
    if suggested_name.contains(['\\', '/'])
        || Path::new(&suggested_name)
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("pdf"))
    {
        return Err("Tên file lưu phải là một tên PDF, không kèm đường dẫn.".to_string());
    }
    let title = clean_display_text(&request.title, 255)
        .ok_or_else(|| "Tiêu đề hộp thoại lưu không hợp lệ.".to_string())?;
    Ok((suggested_name, title))
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// Không cho đường Save As của child đi qua symlink/junction ở bất kỳ thư mục cha
/// nào. Canonicalize đơn thuần chỉ resolve link tại một thời điểm và vẫn để lại cửa
/// sổ tráo reparse trước khi sink mở file tạm.
fn reject_reparse_components(path: &Path) -> Result<(), String> {
    let mut ancestors = path
        .ancestors()
        .filter(|component| !component.as_os_str().is_empty())
        .collect::<Vec<_>>();
    ancestors.reverse();
    for component in ancestors {
        let metadata = std::fs::symlink_metadata(component)
            .map_err(|_| "Không xác minh được chuỗi thư mục lưu PDF.".to_string())?;
        if metadata_is_reparse_point(&metadata) {
            return Err(
                "Đích lưu PDF không được đi qua liên kết hoặc junction thư mục.".to_string(),
            );
        }
        if !metadata.is_dir() {
            return Err("Chuỗi thư mục lưu PDF không hợp lệ.".to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn lock_save_target_directories(
    binding: &SaveTargetBinding,
) -> Result<Vec<LockedSaveDirectory>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
    };

    let mut directories = binding
        .canonical_parent
        .ancestors()
        .filter(|component| !component.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    directories.reverse();

    let mut locked = Vec::with_capacity(directories.len());
    for directory in directories {
        let identity_before = windows_file_identity(&directory)
            .ok_or_else(|| "Không đọc được định danh thư mục lưu PDF.".to_string())?;
        let handle = OpenOptions::new()
            // SEC (audit 2026-09-04 §SEC.15-R2): FILE_TRAVERSE làm handle tham gia
            // sharing contract mà không đòi quyền liệt kê trên ancestor/NAS; hai lease
            // cùng parent vẫn đồng tồn tại. Chỉ quyền attribute không đủ chặn rename.
            .access_mode(FILE_READ_ATTRIBUTES.0 | FILE_TRAVERSE.0)
            // SEC (audit 2026-09-04 §SEC.15): cố ý KHÔNG có FILE_SHARE_DELETE.
            // Handle còn sống sẽ chặn rename/delete component cho tới khi sink xong.
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(&directory)
            .map_err(|_| "Không khóa được chuỗi thư mục lưu PDF.".to_string())?;
        let metadata = handle
            .metadata()
            .map_err(|_| "Không xác minh được handle thư mục lưu PDF.".to_string())?;
        if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
            return Err(
                "Đích lưu PDF không được đi qua liên kết hoặc junction thư mục.".to_string(),
            );
        }
        let identity_after = windows_file_identity(&directory)
            .ok_or_else(|| "Không đọc lại được định danh thư mục lưu PDF.".to_string())?;
        if identity_before != identity_after {
            return Err("Chuỗi thư mục lưu PDF đã thay đổi khi cấp quyền.".to_string());
        }
        locked.push(LockedSaveDirectory {
            path: directory,
            identity: identity_after,
            _handle: handle,
        });
    }
    if locked.last().map(|entry| entry.identity) != binding.canonical_parent_identity {
        return Err("Thư mục lưu PDF không còn đúng định danh đã được cấp.".to_string());
    }
    Ok(locked)
}

#[cfg(windows)]
fn lock_protected_sources(
    protected: &[ProtectedSource],
) -> Result<Vec<LockedProtectedSource>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut locked = Vec::with_capacity(protected.len());
    for source in protected {
        let expected_identity = source
            .file_identity
            .ok_or_else(|| "Không bind được định danh nguồn cần bảo vệ.".to_string())?;
        let handle = OpenOptions::new()
            // FILE_READ_DATA làm handle tham gia sharing contract nhưng vẫn tương
            // thích với ứng dụng đồ họa/grant khác đang share READ|WRITE. Chỉ quyền
            // attribute không đủ chặn rename trên Windows hiện đại.
            .access_mode(FILE_READ_ATTRIBUTES.0 | FILE_READ_DATA.0)
            // Cho ứng dụng đồ họa đang mở source tiếp tục đọc/ghi, nhưng cố ý
            // KHÔNG share DELETE: rename/delete mọi hardlink của identity này phải
            // thất bại cho tới khi grant bị tiêu và lượt publish kết thúc.
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .open(&source.lexical_path)
            .map_err(|_| "Không khóa được nguồn cần bảo vệ trước khi cấp vé lưu.".to_string())?;
        if !handle
            .metadata()
            .map_err(|_| "Không xác minh được handle nguồn cần bảo vệ.".to_string())?
            .is_file()
        {
            return Err("Nguồn cần bảo vệ không còn là file thường.".to_string());
        }
        let observed_identity = windows_file_identity_from_handle(&handle)
            .ok_or_else(|| "Không đọc được định danh từ handle nguồn cần bảo vệ.".to_string())?;
        if observed_identity != expected_identity {
            return Err("Nguồn cần bảo vệ đã bị thay thế trước khi cấp vé lưu.".to_string());
        }
        locked.push(LockedProtectedSource {
            identity: observed_identity,
            handle,
        });
    }
    Ok(locked)
}

fn acquire_save_target_lease(
    binding: SaveTargetBinding,
    consumed_grant: ConsumedSaveGrant,
) -> Result<SaveTargetLease, String> {
    reject_reparse_components(&binding.canonical_parent)?;
    #[cfg(windows)]
    let locked_directories = lock_save_target_directories(&binding)?;
    let lease = SaveTargetLease {
        target_path: binding.target_path(),
        canonical_parent: binding.canonical_parent,
        #[cfg(windows)]
        locked_directories,
        #[cfg(windows)]
        locked_protected_sources: consumed_grant.locked_protected_sources,
    };
    #[cfg(not(windows))]
    let _ = consumed_grant;
    lease.verify()?;
    Ok(lease)
}

/// Chuẩn hóa đúng parent mà hộp thoại native vừa chọn nhưng giữ nguyên basename
/// theo từng ký tự. Đây là binding lexical-exact của grant, không phải phép so path
/// không phân biệt hoa/thường của Windows.
fn canonical_save_target(path: &Path) -> Result<SaveTargetBinding, String> {
    if !path.is_absolute() {
        return Err("Đích lưu PDF phải là đường dẫn tuyệt đối.".to_string());
    }
    let extension_ok = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
    if !extension_ok {
        return Err("Cửa sổ tài liệu chỉ được lưu thành file PDF.".to_string());
    }
    let raw = path
        .to_str()
        .ok_or_else(|| "Đường dẫn lưu PDF không biểu diễn được bằng Unicode.".to_string())?;
    if raw.len() > 32_767 || is_sensitive_write_path(raw) {
        return Err("Đích lưu PDF không được phép sử dụng.".to_string());
    }

    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| "Đích lưu PDF không có thư mục cha hợp lệ.".to_string())?;
    reject_reparse_components(parent)?;
    let exact_file_name = path
        .file_name()
        .ok_or_else(|| "Đích lưu PDF không có tên file.".to_string())?
        .to_os_string();

    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata_is_reparse_point(&metadata) || !metadata.is_file() {
                return Err("Đích lưu PDF phải là file thường hoặc file mới.".to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Không kiểm tra được đích lưu PDF đã chọn.".to_string()),
    }

    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|_| "Không chuẩn hóa được thư mục lưu PDF.".to_string())?;
    if !canonical_parent.is_dir() {
        return Err("Thư mục lưu PDF không hợp lệ.".to_string());
    }
    reject_reparse_components(&canonical_parent)?;
    let canonical_target = canonical_parent.join(&exact_file_name);
    if is_sensitive_write_path(&canonical_target.to_string_lossy()) {
        return Err("Đích lưu PDF không được phép sử dụng.".to_string());
    }
    Ok(SaveTargetBinding {
        canonical_parent_identity: windows_file_identity(&canonical_parent),
        canonical_parent,
        exact_file_name,
    })
}

pub fn is_document_window_label(label: &str) -> bool {
    label.starts_with(DOCUMENT_WINDOW_PREFIX)
}

/// SEC (audit 2026-09-04 §SEC.15): sink gọi hàm này ngay trước lần ghi/copy.
/// Token được bind với label + canonical target, dùng một lần và kiểm lại lineage để
/// bịt cửa sổ TOCTOU giữa lúc đóng hộp thoại với lúc bắt đầu I/O.
pub fn consume_document_save_grant(
    app: &AppHandle,
    window_label: &str,
    path: &Path,
    grant: Option<&str>,
) -> Result<Option<SaveTargetLease>, String> {
    if !is_document_window_label(window_label) {
        return Ok(None);
    }
    let grant = grant
        .filter(|value| {
            value.len() == 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| "Cửa sổ tài liệu phải chọn đích bằng hộp thoại lưu native.".to_string())?;
    let target_binding = canonical_save_target(path)?;
    let registry = app
        .try_state::<Mutex<DocumentWindowRegistry>>()
        .ok_or_else(|| "Registry cửa sổ tài liệu chưa sẵn sàng.".to_string())?;
    let consumed_grant = lock_mutex(&registry).consume_save_grant(
        window_label,
        &target_binding,
        grant,
        Instant::now(),
    )?;
    Ok(Some(acquire_save_target_lease(
        target_binding,
        consumed_grant,
    )?))
}

/// Sau khi sink publish thành công, đích mới trở thành source hiện tại hợp lệ của
/// child. Ghi nó vào lineage native để lượt "New Window" lồng nhau có thể staging
/// source này, đồng thời mọi lượt Save As sau vẫn không được ghi đè lại nó.
pub fn record_document_saved_target(
    app: &AppHandle,
    window_label: &str,
    target: &Path,
) -> Result<(), String> {
    if !is_document_window_label(window_label) {
        return Ok(());
    }
    let canonical_target = std::fs::canonicalize(target)
        .map_err(|_| "Không chuẩn hóa được PDF vừa lưu.".to_string())?;
    let registry = app
        .try_state::<Mutex<DocumentWindowRegistry>>()
        .ok_or_else(|| "Registry cửa sổ tài liệu chưa sẵn sàng.".to_string())?;
    let mut state = lock_mutex(&registry);
    let entry = state
        .live
        .get_mut(window_label)
        .ok_or_else(|| "Cửa sổ tài liệu không còn hiệu lực.".to_string())?;
    push_protected_path(&mut entry.protected_sources, canonical_target);
    Ok(())
}

#[tauri::command]
pub async fn request_document_save_grant(
    app: AppHandle,
    window: WebviewWindow,
    request: DocumentSaveDialogRequest,
) -> Result<Option<DocumentSaveSelection>, String> {
    let window_label = window.label().to_string();
    if !is_document_window_label(&window_label) {
        return Err("Hộp thoại lưu bảo vệ chỉ dành cho cửa sổ tài liệu.".to_string());
    }
    let (suggested_name, title) = validate_save_dialog_request(&request)?;
    let registry = app
        .try_state::<Mutex<DocumentWindowRegistry>>()
        .ok_or_else(|| "Registry cửa sổ tài liệu chưa sẵn sàng.".to_string())?;
    if !lock_mutex(&registry).live.contains_key(&window_label) {
        return Err("Cửa sổ tài liệu chưa nhận bootstrap hoặc đã đóng.".to_string());
    }

    let dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF", &["pdf"])
        .set_file_name(suggested_name)
        .set_title(title);
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|error| format!("Không mở được hộp thoại lưu PDF: {error}"))?;
    let Some(selected) = selected else {
        // Hủy hộp thoại không tạo grant, vì vậy không có capability treo trong registry.
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|_| "Hộp thoại không trả về đường dẫn file cục bộ.".to_string())?;
    let selected_text = selected
        .to_str()
        .ok_or_else(|| "Đường dẫn lưu PDF không biểu diễn được bằng Unicode.".to_string())?
        .to_string();

    // Re-check trạng thái sau lúc user đóng dialog: cửa sổ có thể bị destroy trong lúc
    // dialog đang mở, và grant không được sống lâu hơn chủ sở hữu của nó.
    let grant = lock_mutex(&registry).issue_save_grant(&window_label, selected, Instant::now())?;
    let cleanup_app = app.clone();
    let cleanup_grant = grant.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_GRANT_TTL).await;
        let Some(registry) = cleanup_app.try_state::<Mutex<DocumentWindowRegistry>>() else {
            return;
        };
        let _ = lock_mutex(&registry).expire_save_grant(&cleanup_grant, Instant::now());
    });
    Ok(Some(DocumentSaveSelection {
        path: selected_text,
        grant,
    }))
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
    let (snapshot_path, canonical_source_path, staging_lineage) =
        tauri::async_runtime::spawn_blocking(move || {
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
    let inherited_lineage = {
        let state = lock_mutex(&registry);
        if source_label == "main" {
            Ok(Vec::new())
        } else {
            state.protected_sources_for_child(source_label, &request.document_session_id)
        }
    };
    let mut protected_sources = match inherited_lineage {
        Ok(paths) => paths,
        Err(error) => {
            safe_remove_snapshot(&app, &snapshot_path);
            return Err(error);
        }
    };
    for protected in staging_lineage {
        push_protected_source(&mut protected_sources, protected);
    }
    push_protected_path(&mut protected_sources, canonical_source_path);
    push_protected_path(&mut protected_sources, snapshot_path.clone());

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
            protected_sources,
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

    fn test_dir(label: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "prynx_sec15_{}_{}_{}",
            label,
            std::process::id(),
            stamp
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn add_live_window(
        registry: &mut DocumentWindowRegistry,
        label: &str,
        session: &str,
        protected_source_paths: Vec<PathBuf>,
    ) {
        registry.insert_pending(
            bootstrap(label, session, 2),
            protected_source_paths
                .into_iter()
                .map(ProtectedSource::capture)
                .collect(),
            None,
        );
        assert!(registry.take_for_window(label).is_some());
    }

    #[cfg(windows)]
    fn windows_short_path(path: &Path) -> Option<PathBuf> {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetShortPathNameW;

        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let required = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), None) };
        if required == 0 {
            return None;
        }
        let mut buffer = vec![0u16; required as usize + 1];
        let written = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buffer)) };
        if written == 0 {
            return None;
        }
        Some(PathBuf::from(OsString::from_wide(
            &buffer[..written as usize],
        )))
    }

    #[cfg(windows)]
    fn try_create_junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn bootstrap_chi_duoc_lay_mot_lan_va_chuyen_sang_live() {
        let mut registry = DocumentWindowRegistry::default();
        registry.insert_pending(bootstrap("document-a", "main:tab-a", 2), Vec::new(), None);
        assert!(registry.take_for_window("document-a").is_some());
        assert!(registry.take_for_window("document-a").is_none());
        assert!(registry.live.contains_key("document-a"));
    }

    #[test]
    fn danh_so_cua_so_doc_lap_theo_tai_lieu() {
        let mut registry = DocumentWindowRegistry::default();
        assert_eq!(registry.next_window_number("main:tab-a"), 2);
        registry.insert_pending(bootstrap("document-a", "main:tab-a", 2), Vec::new(), None);
        assert_eq!(registry.next_window_number("main:tab-a"), 3);
        assert_eq!(registry.next_window_number("main:tab-b"), 2);
    }

    #[test]
    fn ready_signal_di_theo_bootstrap_va_chi_phat_mot_lan() {
        let (sender, receiver) = mpsc::channel();
        let mut registry = DocumentWindowRegistry::default();
        registry.insert_pending(
            bootstrap("document-a", "main:tab-a", 2),
            Vec::new(),
            Some(sender),
        );

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
        registry.insert_pending(
            bootstrap("document-a", "main:tab-a", 2),
            Vec::new(),
            Some(sender),
        );

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
        registry.insert_pending(
            bootstrap("document-a", "main:tab-a", 2),
            Vec::new(),
            Some(sender),
        );
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
    fn save_grant_chan_original_snapshot_va_alias_nhung_cho_target_moi_mot_lan() {
        // SEC (audit 2026-09-04 §SEC.15): cả original lẫn snapshot nằm trong
        // lineage native. Exact/case/slash/hardlink/junction/8.3 đều dùng chung
        // oracle file identity với sink, không dựa vào chuỗi renderer gửi.
        let root = test_dir("protected_aliases");
        let real = root.join("ThuMucTaiLieuDaiDeKiemTraAlias");
        std::fs::create_dir_all(&real).unwrap();
        let original = real.join("DonHangKhachHangBanGoc.pdf");
        let snapshot = real.join("snapshot-0123456789abcdef0123456789abcdef.pdf");
        std::fs::write(&original, b"%PDF-original").unwrap();
        std::fs::write(&snapshot, b"%PDF-snapshot").unwrap();

        let mut registry = DocumentWindowRegistry::default();
        add_live_window(
            &mut registry,
            "document-a",
            "main:tab-a",
            vec![original.clone(), snapshot.clone()],
        );
        let now = Instant::now();
        for candidate in [
            original.clone(),
            PathBuf::from(original.to_string_lossy().to_uppercase()),
            PathBuf::from(original.to_string_lossy().replace('\\', "/")),
            snapshot.clone(),
            PathBuf::from(snapshot.to_string_lossy().to_uppercase()),
        ] {
            assert!(
                registry
                    .issue_save_grant("document-a", candidate.clone(), now)
                    .is_err(),
                "phải chặn đích protected: {}",
                candidate.display()
            );
        }

        for (source, alias_name) in [
            (&original, "hardlink-original.pdf"),
            (&snapshot, "hardlink-snapshot.pdf"),
        ] {
            let alias = real.join(alias_name);
            match std::fs::hard_link(source, &alias) {
                Ok(()) => assert!(
                    registry.issue_save_grant("document-a", alias, now).is_err(),
                    "hardlink của source/snapshot phải bị từ chối"
                ),
                Err(error) => {
                    eprintln!("SKIP alias hardlink §SEC.15: không tạo được hardlink ({error})")
                }
            }
        }

        #[cfg(windows)]
        {
            if let Some(short) = windows_short_path(&original) {
                if disk_compare_key(&short) != disk_compare_key(&original) {
                    eprintln!("SKIP alias 8.3 §SEC.15: volume không trả về một short path riêng");
                } else {
                    assert!(registry.issue_save_grant("document-a", short, now).is_err());
                }
            } else {
                eprintln!("SKIP alias 8.3 §SEC.15: 8.3 tắt trên volume test");
            }

            let junction = root.join("LoiTat");
            if try_create_junction(&junction, &real) {
                assert!(registry
                    .issue_save_grant(
                        "document-a",
                        junction.join(original.file_name().unwrap()),
                        now,
                    )
                    .is_err());
                assert!(registry
                    .issue_save_grant(
                        "document-a",
                        junction.join(snapshot.file_name().unwrap()),
                        now,
                    )
                    .is_err());
                std::fs::remove_dir(&junction).unwrap();
            } else {
                eprintln!("SKIP alias junction §SEC.15: môi trường không tạo được junction");
            }
        }

        let target_path = real.join("BanLuuMoi.pdf");
        let target = canonical_save_target(&target_path).unwrap();
        let grant = registry
            .issue_save_grant("document-a", target_path, now)
            .expect("target mới hợp lệ phải được cấp grant");
        assert_eq!(grant.len(), 32, "grant phải có entropy 128-bit dạng hex");
        assert!(registry
            .consume_save_grant("document-a", &target, &grant, now)
            .is_ok());
        assert!(registry
            .consume_save_grant("document-a", &target, &grant, now)
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_grant_bind_label_path_ttl_va_vong_doi_window() {
        let root = test_dir("grant_binding");
        let original = root.join("original.pdf");
        std::fs::write(&original, b"%PDF-original").unwrap();
        let target_path = root.join("target.pdf");
        let other_path = root.join("other.pdf");
        let target = canonical_save_target(&target_path).unwrap();
        let other = canonical_save_target(&other_path).unwrap();
        let now = Instant::now();
        let mut registry = DocumentWindowRegistry::default();
        add_live_window(
            &mut registry,
            "document-a",
            "main:tab-a",
            vec![original.clone()],
        );
        add_live_window(&mut registry, "document-b", "main:tab-b", vec![original]);

        let cross_window = registry
            .issue_save_grant("document-a", target_path.clone(), now)
            .unwrap();
        assert!(registry
            .consume_save_grant("document-b", &target, &cross_window, now)
            .is_err());
        assert!(registry
            .consume_save_grant("document-a", &target, &cross_window, now)
            .is_err());

        let wrong_path = registry
            .issue_save_grant("document-a", target_path.clone(), now)
            .unwrap();
        assert!(registry
            .consume_save_grant("document-a", &other, &wrong_path, now)
            .is_err());
        assert!(registry
            .consume_save_grant("document-a", &target, &wrong_path, now)
            .is_err());

        let expired_at = now
            .checked_sub(SAVE_GRANT_TTL + Duration::from_secs(1))
            .unwrap();
        let expired = registry
            .issue_save_grant("document-a", target_path.clone(), expired_at)
            .unwrap();
        assert!(registry
            .consume_save_grant("document-a", &target, &expired, now)
            .is_err());

        let destroyed = registry
            .issue_save_grant("document-a", target_path, now)
            .unwrap();
        assert!(registry.remove_window("document-a").is_some());
        assert!(registry
            .consume_save_grant("document-a", &target, &destroyed, now)
            .is_err());
        assert!(registry
            .consume_save_grant("document-a", &target, "sai-token", now)
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn save_grant_tu_tha_handle_dung_ttl_khong_can_request_ke_tiep() {
        // SEC (audit 2026-09-04 §SEC.15-R2): mô phỏng timer của command. Trước
        // bản vá, TTL chỉ được prune bởi một lượt issue/consume khác nên source
        // vẫn bị khóa vô hạn nếu renderer bỏ grant sau khi chọn đích.
        let root = test_dir("grant_timer_expiry");
        let original = root.join("DonHangGoc.pdf");
        let renamed = root.join("DonHangDaDoiTen.pdf");
        let target = root.join("BanLuuMoi.pdf");
        std::fs::write(&original, b"%PDF-original").unwrap();

        let now = Instant::now();
        let mut registry = DocumentWindowRegistry::default();
        add_live_window(
            &mut registry,
            "document-a",
            "main:tab-a",
            vec![original.clone()],
        );
        let grant = registry
            .issue_save_grant("document-a", target, now)
            .unwrap();

        assert!(std::fs::rename(&original, &renamed).is_err());
        assert!(
            !registry.expire_save_grant(&grant, now + SAVE_GRANT_TTL - Duration::from_millis(1),)
        );
        assert!(std::fs::rename(&original, &renamed).is_err());
        assert!(registry.expire_save_grant(&grant, now + SAVE_GRANT_TTL));
        std::fs::rename(&original, &renamed)
            .expect("handle của grant hết hạn phải được thả mà không cần request mới");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn save_grant_bind_basename_chinh_xac_khong_nhan_bien_the_hoa_thuong() {
        // SEC (audit 2026-09-04 §SEC.15): NTFS mở hai basename khác case như nhau,
        // nhưng grant phải bind đúng chuỗi hộp thoại native đã trả về.
        let root = test_dir("grant_exact_case");
        let original = root.join("original.pdf");
        std::fs::write(&original, b"%PDF-original").unwrap();
        let selected = root.join("BanLuuKhachHang.pdf");
        let mutated = root.join("banluukhachhang.pdf");
        let selected_binding = canonical_save_target(&selected).unwrap();
        let mutated_binding = canonical_save_target(&mutated).unwrap();
        assert_ne!(selected_binding, mutated_binding);

        let now = Instant::now();
        let mut registry = DocumentWindowRegistry::default();
        add_live_window(&mut registry, "document-a", "main:tab-a", vec![original]);
        let grant = registry
            .issue_save_grant("document-a", selected.clone(), now)
            .unwrap();
        let error = registry
            .consume_save_grant("document-a", &mutated_binding, &grant, now)
            .expect_err("biến thể case không được dùng grant đã bind basename exact");
        assert!(error.contains("không khớp vị trí"));
        assert!(registry
            .consume_save_grant("document-a", &selected_binding, &grant, now)
            .is_err());

        let exact_grant = registry
            .issue_save_grant("document-a", selected, now)
            .unwrap();
        assert!(registry
            .consume_save_grant("document-a", &selected_binding, &exact_grant, now)
            .is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn protected_identity_theo_file_sau_rename_va_van_giu_ten_cu() {
        // SEC (audit 2026-09-04 §SEC.15): identity chặn tên mới của file gốc;
        // lexical path chặn cả file thay thế được đặt lại đúng tên cũ.
        let root = test_dir("protected_rename");
        let original = root.join("DonHangGoc.pdf");
        let renamed = root.join("DonHangDaDoiTen.pdf");
        std::fs::write(&original, b"%PDF-original").unwrap();
        let original_identity = windows_file_identity(&original)
            .expect("fixture file thường phải có định danh Windows");

        let mut registry = DocumentWindowRegistry::default();
        add_live_window(
            &mut registry,
            "document-a",
            "main:tab-a",
            vec![original.clone()],
        );
        std::fs::rename(&original, &renamed).unwrap();
        assert_eq!(windows_file_identity(&renamed), Some(original_identity));
        assert!(
            registry
                .issue_save_grant("document-a", renamed, Instant::now())
                .is_err(),
            "tên mới của original vẫn phải bị chặn bằng stable identity"
        );

        std::fs::write(&original, b"%PDF-replacement").unwrap();
        assert!(
            registry
                .issue_save_grant("document-a", original, Instant::now())
                .is_err(),
            "file thay thế tại tên lexical cũ vẫn phải bị chặn"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn save_grant_giu_khoa_nguon_tu_luc_cap_den_lease_publish() {
        // SEC (audit 2026-09-04 §SEC.15-R2): reproducer cũ đổi tên source vào
        // selected target sau khi grant đã cấp. Handle không share DELETE phải sống
        // cả trong registry lẫn sau lúc consume, cho tới khi sink drop lease.
        let root = test_dir("protected_handle_lease");
        let original = root.join("DonHangGoc.pdf");
        let target = root.join("BanLuuDaChon.pdf");
        std::fs::write(&original, b"%PDF-original").unwrap();

        let mut registry = DocumentWindowRegistry::default();
        add_live_window(
            &mut registry,
            "document-a",
            "main:tab-a",
            vec![original.clone()],
        );
        let now = Instant::now();
        let binding = canonical_save_target(&target).unwrap();
        let grant = registry
            .issue_save_grant("document-a", target.clone(), now)
            .unwrap();

        assert!(
            std::fs::rename(&original, &target).is_err(),
            "grant đang chờ phải chặn rename source vào selected target"
        );
        let consumed = registry
            .consume_save_grant("document-a", &binding, &grant, now)
            .unwrap();
        assert!(
            std::fs::rename(&original, &target).is_err(),
            "consume không được làm rơi handle nguồn trước khi dựng lease"
        );

        let lease = acquire_save_target_lease(binding, consumed).unwrap();
        assert!(lease.verify().is_ok());
        assert!(
            std::fs::rename(&original, &target).is_err(),
            "lease publish phải tiếp tục chặn rename source"
        );
        drop(lease);

        std::fs::rename(&original, &target)
            .expect("sau khi kết thúc lượt publish, source phải đổi tên lại được");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn save_guard_cho_phep_hai_grant_va_hai_lease_dong_thoi() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        // SEC (audit 2026-09-04 §SEC.15-R2): handle khóa chỉ cần từ chối
        // FILE_SHARE_DELETE, không được tự xin DELETE rồi xung đột với ứng dụng đồ
        // họa hoặc grant/lease khác của chính PrynX trên cùng source và thư mục đích.
        let root = test_dir("concurrent_save_guards");
        let original = root.join("DonHangGoc.pdf");
        let renamed = root.join("DonHangDaDoiTen.pdf");
        let first_target = root.join("BanLuuMot.pdf");
        let second_target = root.join("BanLuuHai.pdf");
        std::fs::write(&original, b"%PDF-original").unwrap();
        let editor_handle = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .open(&original)
            .expect("mô phỏng ứng dụng đồ họa đang mở source không share DELETE");

        let mut registry = DocumentWindowRegistry::default();
        add_live_window(
            &mut registry,
            "document-a",
            "main:tab-a",
            vec![original.clone()],
        );
        let now = Instant::now();
        let first_binding = canonical_save_target(&first_target).unwrap();
        let second_binding = canonical_save_target(&second_target).unwrap();

        let first_grant = registry
            .issue_save_grant("document-a", first_target, now)
            .expect("grant đầu phải được giữ sống");
        let second_grant = registry
            .issue_save_grant("document-a", second_target, now)
            .expect("grant thứ hai không được tự xung đột với grant đầu");
        assert!(
            std::fs::rename(&original, &renamed).is_err(),
            "hai grant đang chờ vẫn phải chặn rename source"
        );

        let first_consumed = registry
            .consume_save_grant("document-a", &first_binding, &first_grant, now)
            .unwrap();
        let second_consumed = registry
            .consume_save_grant("document-a", &second_binding, &second_grant, now)
            .unwrap();
        let first_lease = acquire_save_target_lease(first_binding, first_consumed).unwrap();
        let second_lease = acquire_save_target_lease(second_binding, second_consumed)
            .expect("lease thứ hai cùng parent không được tự xung đột với lease đầu");
        assert!(first_lease.verify().is_ok());
        assert!(second_lease.verify().is_ok());

        drop(first_lease);
        assert!(
            std::fs::rename(&original, &renamed).is_err(),
            "lease còn lại vẫn phải giữ khóa rename source"
        );
        drop(second_lease);
        drop(editor_handle);
        std::fs::rename(&original, &renamed)
            .expect("sau khi mọi grant/lease kết thúc, source phải đổi tên lại được");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn identity_none_cua_target_ton_tai_phai_fail_closed() {
        // SEC (audit 2026-09-04 §SEC.15): test thẳng policy với observation được
        // tiêm vào. FILE_READ_ATTRIBUTES có thể vẫn mở qua một số share lock Windows,
        // nên mô phỏng `None` ở biên này ổn định hơn một test phụ thuộc driver/filesystem.
        let protected = ProtectedSource {
            lexical_path: PathBuf::from(r"C:\du_lieu\original.pdf"),
            file_identity: Some((11, 22, 33)),
        };
        let other = Path::new(r"C:\du_lieu\target.pdf");
        assert!(protected
            .conflicts_with_observation(other, true, None)
            .is_err());
        assert!(!protected
            .conflicts_with_observation(other, true, Some((44, 55, 66)))
            .unwrap());
        assert!(protected
            .conflicts_with_observation(other, true, Some((11, 22, 33)))
            .unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn save_target_lease_chan_rename_va_thay_parent_bang_junction() {
        let root = test_dir("save_target_lease");
        let selected_parent = root.join("thu_muc_da_chon");
        let moved_parent = root.join("thu_muc_that_da_doi_ten");
        let moved_root = root.with_file_name(format!(
            "{}_moved",
            root.file_name().unwrap().to_string_lossy()
        ));
        let attacker_parent = root.join("thu_muc_tan_cong");
        std::fs::create_dir_all(&selected_parent).unwrap();
        std::fs::create_dir_all(&attacker_parent).unwrap();
        let binding = canonical_save_target(&selected_parent.join("BanLuu.pdf")).unwrap();
        let lease = acquire_save_target_lease(binding, ConsumedSaveGrant::default()).unwrap();

        // Đối chứng dương: lease chỉ khóa identity của thư mục, không cản sink tạo
        // temp rồi publish một file con hợp lệ trong chính thư mục đó.
        let temp = selected_parent.join(".probe.tmp");
        let target = selected_parent.join("BanLuu.pdf");
        std::fs::write(&temp, b"%PDF-probe").unwrap();
        std::fs::rename(&temp, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-probe");

        assert!(
            std::fs::rename(&selected_parent, &moved_parent).is_err(),
            "handle không share DELETE phải chặn rename parent khi sink đang chạy"
        );
        assert!(
            std::fs::rename(&root, &moved_root).is_err(),
            "lease phải chặn cả rename ancestor trong chuỗi thư mục đích"
        );
        assert!(lease.verify().is_ok());
        drop(lease);

        std::fs::rename(&selected_parent, &moved_parent)
            .expect("sau khi drop lease, parent phải đổi tên được");
        if !try_create_junction(&selected_parent, &attacker_parent) {
            eprintln!(
                "SKIP nửa junction của save_target_lease: môi trường không tạo được junction"
            );
            std::fs::rename(&moved_parent, &selected_parent).unwrap();
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        assert_eq!(
            std::fs::canonicalize(&selected_parent).unwrap(),
            std::fs::canonicalize(&attacker_parent).unwrap(),
            "sau drop, chuỗi rename + junction phải thực sự đổi nghĩa path"
        );
        assert!(
            canonical_save_target(&selected_parent.join("BanLuuKhac.pdf")).is_err(),
            "lượt grant mới cũng phải từ chối parent đã biến thành junction"
        );
        std::fs::remove_dir(&selected_parent).unwrap();
        std::fs::rename(&moved_parent, &selected_parent).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn child_long_nhau_ke_thua_lineage_va_bat_buoc_cung_session() {
        let root = test_dir("nested_lineage");
        let original = root.join("original.pdf");
        let parent_snapshot = root.join("parent-snapshot.pdf");
        let staging = root.join("staging.pdf");
        let child_snapshot = root.join("child-snapshot.pdf");
        for path in [&original, &parent_snapshot, &staging, &child_snapshot] {
            std::fs::write(path, b"%PDF-test").unwrap();
        }
        let mut registry = DocumentWindowRegistry::default();
        add_live_window(
            &mut registry,
            "document-parent",
            "main:tab-a",
            vec![original.clone(), parent_snapshot.clone()],
        );
        assert!(registry
            .protected_sources_for_child("document-parent", "main:tab-khac")
            .is_err());

        let staging_lineage = registry
            .staging_lineage_for_caller("document-parent", &parent_snapshot, false)
            .expect("snapshot của parent phải được dùng làm staging nested child");
        registry.register_staging_source(staging.clone(), staging_lineage, Instant::now());
        let mut nested_lineage = registry
            .consume_staging_source(&staging, Instant::now())
            .expect("staging grant phải mang lineage native");
        push_protected_path(&mut nested_lineage, staging.clone());
        push_protected_path(&mut nested_lineage, child_snapshot.clone());
        registry.insert_pending(
            bootstrap("document-child", "main:tab-a", 2),
            nested_lineage,
            None,
        );
        assert!(registry.take_for_window("document-child").is_some());

        let inherited = registry
            .protected_sources_for_child("document-child", "main:tab-a")
            .unwrap();
        for protected in [original, parent_snapshot, staging, child_snapshot] {
            assert!(
                protected_sources_conflict(&inherited, &protected).unwrap(),
                "nested child phải giữ protected path {}",
                protected.display()
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn grant_staging_chi_duoc_dung_mot_lan_va_co_han() {
        let now = Instant::now();
        let path = PathBuf::from("staging.pdf");
        let lineage = vec![ProtectedSource::capture(PathBuf::from("original.pdf"))];
        let mut registry = DocumentWindowRegistry::default();
        registry.register_staging_source(path.clone(), lineage.clone(), now);
        let consumed = registry
            .consume_staging_source(&path, now)
            .expect("grant staging phải trả lineage");
        assert_eq!(consumed.len(), lineage.len());
        assert_eq!(consumed[0].lexical_path, lineage[0].lexical_path);
        assert!(registry.consume_staging_source(&path, now).is_none());

        let expired_at = now
            .checked_sub(STAGING_GRANT_TTL + Duration::from_secs(1))
            .unwrap();
        registry.register_staging_source(path.clone(), Vec::new(), expired_at);
        assert!(registry.consume_staging_source(&path, now).is_none());
    }
}
