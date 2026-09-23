//! Protocol nhị phân giữa process UI và display worker của Viewer.
//!
//! Mỗi frame có dạng:
//! `PXRW | version:u16 LE | kind:u16 LE | request_id:u64 LE | header_len:u32 LE |
//! payload_len:u64 LE | JSON | payload`.
//! Header JSON dùng để điều phối; payload chỉ chứa dữ liệu nhị phân (PNG ở response render).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
#[cfg(test)]
use std::sync::TryLockError;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use image::{ColorType, ImageEncoder};
use print_engine::color::RenderIntent;
use print_engine::content::RenderOptions;
use print_engine::oc::OptionalContentUsage;
use print_engine::page::{PageBox, RasterClip};
use print_engine::{CancelToken, PpeError, RenderSession, RenderWarnings};

mod response_router;

pub const RENDER_WORKER_MAGIC: [u8; 4] = *b"PXRW";
pub const RENDER_WORKER_PROTOCOL_VERSION: u16 = 4;
pub const RENDER_WORKER_MAX_HEADER_BYTES: usize = 64 * 1024;
pub const RENDER_WORKER_MAX_PAYLOAD_BYTES: u64 = 512 * 1024 * 1024;
pub const RENDER_WORKER_FRAME_PREFIX_BYTES: usize = 4 + 2 + 2 + 8 + 4 + 8;
pub const RENDER_WORKER_DISPLAY_PIPELINE_ID: &str = "pdfium-display-png-v1";
pub const RENDER_WORKER_ACCURATE_PIPELINE_ID: &str =
    "ppe-fogra39-relative-view-knockout-png-v5-native-worker";
pub const PPE_NATIVE_FALLBACK_BEFORE_START_PREFIX: &str = "PPE_NATIVE_FALLBACK_BEFORE_START:";
pub const PPE_NATIVE_UNSUPPORTED_PREFIX: &str = "PPE_NATIVE_UNSUPPORTED:";
const RENDER_WORKER_MAX_ID_BYTES: usize = 256;
const RENDER_WORKER_MAX_PATH_BYTES: usize = 32 * 1024;
const PPE_WORKER_PROFILE_ID: &str = "fogra39";
const PPE_WORKER_INTENT: &str = "relative";
const ACCURATE_SESSION_OWNER_TTL: Duration = Duration::from_secs(10 * 60);
const ACCURATE_SESSION_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const FOGRA39_ICC_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../backend/app/assets/icc/FOGRA39.icc"
));
const PPE_FALLBACK_FONT_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../backend/app/assets/fonts/DejaVuSans.ttf"
));
const PPE_FALLBACK_BOLD_FONT_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../backend/app/assets/fonts/DejaVuSans-Bold.ttf"
));
const PPE_FALLBACK_FONT_SHA256: &str =
    "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954";

fn ppe_fallback_font() -> Arc<Vec<u8>> {
    static FONT: OnceLock<Arc<Vec<u8>>> = OnceLock::new();
    FONT.get_or_init(|| Arc::new(PPE_FALLBACK_FONT_BYTES.to_vec()))
        .clone()
}

fn ppe_fallback_bold_font() -> Arc<Vec<u8>> {
    static FONT: OnceLock<Arc<Vec<u8>>> = OnceLock::new();
    FONT.get_or_init(|| Arc::new(PPE_FALLBACK_BOLD_FONT_BYTES.to_vec()))
        .clone()
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct AccurateSessionKey {
    document_path: String,
    document_token: String,
    profile_path: PathBuf,
    intent: String,
}

struct AccurateSessionEntry {
    session: RenderSession,
    last_used: u64,
    owners: AccurateOwnerLeases,
    in_flight: Arc<AtomicUsize>,
}

#[derive(Default)]
struct AccurateOwnerLeases {
    last_seen: HashMap<String, Instant>,
}

impl AccurateOwnerLeases {
    fn bind(&mut self, owner_id: &str, now: Instant) {
        self.last_seen.insert(owner_id.to_string(), now);
    }

    fn release(&mut self, owner_id: &str) -> bool {
        self.last_seen.remove(owner_id).is_some()
    }

    fn prune_stale(&mut self, now: Instant, ttl: Duration) -> usize {
        let before = self.last_seen.len();
        self.last_seen.retain(|_, last_seen| {
            now.checked_duration_since(*last_seen)
                .is_none_or(|age| age <= ttl)
        });
        before.saturating_sub(self.last_seen.len())
    }

    fn is_empty(&self) -> bool {
        self.last_seen.is_empty()
    }
}

#[derive(Default)]
struct AccurateSessionPool {
    entries: HashMap<AccurateSessionKey, AccurateSessionEntry>,
    sequence: u64,
}

fn accurate_sessions() -> &'static Mutex<AccurateSessionPool> {
    static SESSIONS: OnceLock<Mutex<AccurateSessionPool>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(AccurateSessionPool::default()))
}

fn close_ownerless_accurate_sessions(pool: &mut AccurateSessionPool) -> usize {
    let keys = pool
        .entries
        .iter()
        .filter_map(|(key, entry)| (entry.owners.is_empty()
            && entry.in_flight.load(Ordering::Acquire) == 0).then_some(key.clone()))
        .collect::<Vec<_>>();
    for key in &keys {
        if let Some(mut entry) = pool.entries.remove(key) {
            entry.session.close();
        }
    }
    keys.len()
}

fn prune_stale_accurate_session_owners(now: Instant) -> usize {
    let mut pool = accurate_sessions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut released = 0;
    for entry in pool.entries.values_mut() {
        released += entry.owners.prune_stale(now, ACCURATE_SESSION_OWNER_TTL);
    }
    let closed = close_ownerless_accurate_sessions(&mut pool);
    if released > 0 || closed > 0 {
        eprintln!(
            "[PXRW] dọn owner PPE stale: owners={} sessions={}",
            released, closed
        );
    }
    closed
}

fn start_accurate_session_sweeper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        // PERF (audit 2026-08-09 §L3C): WebView crash không phát cleanup. Worker tự
        // thu owner im lặng quá TTL; tab còn hoạt động chạm lại lease ở mỗi render.
        let _ = std::thread::Builder::new()
            .name("prynx-ppe-owner-sweeper".to_string())
            .spawn(|| loop {
                std::thread::sleep(ACCURATE_SESSION_SWEEP_INTERVAL);
                prune_stale_accurate_session_owners(Instant::now());
            });
    });
}

fn release_accurate_session_owner(owner_id: &str) -> bool {
    let mut pool = accurate_sessions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    release_accurate_owner_from_pool(&mut pool, owner_id)
}

fn release_accurate_owner_from_pool(pool: &mut AccurateSessionPool, owner_id: &str) -> bool {
    let mut released = false;
    // Close do caller yêu cầu khác sweep TTL: last-owner phải vô hiệu hóa cả
    // snapshot đang raster; job kiểm lại sau encode, không phát bitmap đã đóng.
    pool.entries.retain(|_, entry| {
        let removed = entry.owners.release(owner_id);
        released |= removed;
        if entry.owners.is_empty() && (removed || entry.in_flight.load(Ordering::Acquire) == 0) {
            entry.session.close(); false
        } else { true }
    });
    released
}

fn checked_mebibytes(value: u64) -> usize {
    value.saturating_mul(1024 * 1024).min(usize::MAX as u64) as usize
}

fn accurate_worker_budgets() -> (usize, usize) {
    const GIB: u64 = 1024 * 1024 * 1024;
    let Some(status) = crate::system_memory_status() else {
        return (checked_mebibytes(512), checked_mebibytes(128));
    };
    let total = status.total_bytes;
    let available = status.available_bytes.max(1);
    let lanes = configured_background_lane_count().saturating_add(1).max(1) as u64;
    if total < 8 * GIB {
        let render = (available / lanes / 2).clamp(256 * 1024 * 1024, 384 * 1024 * 1024);
        let cache = (available * 8 / 100 / lanes).clamp(32 * 1024 * 1024, 96 * 1024 * 1024);
        return (render as usize, cache as usize);
    }
    if total < 16 * GIB {
        let render = (available / lanes / 2).clamp(512 * 1024 * 1024, 1024 * 1024 * 1024);
        let cache = (available * 12 / 100 / lanes).clamp(96 * 1024 * 1024, 256 * 1024 * 1024);
        return (render as usize, cache as usize);
    }
    // PERF (audit 2026-08-09 §L3A): máy mạnh co giãn theo RAM còn trống và số
    // lane thật; không dùng ceiling cố định làm máy 32/64 GB chậm như máy yếu.
    let render = (available * 75 / 100 / lanes).max(512 * 1024 * 1024);
    let cache = (available / 8 / lanes).max(256 * 1024 * 1024);
    (
        render.min(usize::MAX as u64) as usize,
        cache.min(usize::MAX as u64) as usize,
    )
}

fn accurate_session_limit_for_hardware(
    total_ram_bytes: Option<u64>,
    available_ram_bytes: Option<u64>,
) -> Option<usize> {
    const GIB: u64 = 1024 * 1024 * 1024;
    match total_ram_bytes {
        Some(total) if total < 8 * GIB => Some(1),
        Some(total) if total < 16 * GIB => Some(2),
        Some(total) => {
            let available = available_ram_bytes.unwrap_or(total);
            // PERF (audit 2026-08-09 §L3B): máy mạnh chỉ thu cache khi hệ thống
            // thật sự chịu áp lực; trạng thái bình thường không có hard-cap session.
            (available < 4 * GIB || available.saturating_mul(10) < total).then_some(1)
        }
        None => None,
    }
}

fn materialize_embedded_fogra39() -> Result<PathBuf, String> {
    let digest = hex::encode(sha2::Sha256::digest(FOGRA39_ICC_BYTES));
    let directory = std::env::temp_dir()
        .join("PrynX")
        .join("icc")
        .join(&digest[..16]);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Không tạo được cache ICC PPE: {error}"))?;
    let target = directory.join("FOGRA39.icc");
    let valid_existing = std::fs::read(&target).ok().is_some_and(|bytes| {
        sha2::Sha256::digest(&bytes)[..] == sha2::Sha256::digest(FOGRA39_ICC_BYTES)[..]
    });
    if !valid_existing {
        let temporary = directory.join(format!(
            ".FOGRA39.{}.{}.tmp",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&temporary, FOGRA39_ICC_BYTES)
            .map_err(|error| format!("Không ghi được ICC PPE tạm: {error}"))?;
        if target.exists() {
            let _ = std::fs::remove_file(&target);
        }
        if let Err(error) = std::fs::rename(&temporary, &target) {
            let raced_valid = std::fs::read(&target).ok().is_some_and(|bytes| {
                sha2::Sha256::digest(&bytes)[..] == sha2::Sha256::digest(FOGRA39_ICC_BYTES)[..]
            });
            let _ = std::fs::remove_file(&temporary);
            if !raced_valid {
                return Err(format!("Không cài được ICC PPE đã pin: {error}"));
            }
        }
    }
    std::fs::canonicalize(&target)
        .map_err(|error| format!("Không canonicalize được ICC PPE đã pin: {error}"))
}

fn accurate_profile_path(profile_id: &str) -> Result<PathBuf, String> {
    if profile_id != PPE_WORKER_PROFILE_ID {
        return Err(format!(
            "PPE worker chưa cho phép profile '{profile_id}'; chỉ nhận {PPE_WORKER_PROFILE_ID}."
        ));
    }
    static PROFILE: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    PROFILE.get_or_init(materialize_embedded_fogra39).clone()
}

fn close_accurate_sessions_for_path(path: &str) -> bool {
    let mut pool = accurate_sessions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let keys = pool
        .entries
        .keys()
        .filter(|key| key.document_path == path)
        .cloned()
        .collect::<Vec<_>>();
    for key in &keys {
        if let Some(mut entry) = pool.entries.remove(key) {
            entry.session.close();
        }
    }
    !keys.is_empty()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderWorkerMode {
    Off,
    Auto,
    Required,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewerEngineMode {
    Current,
    Hybrid,
    PpeOnly,
}

impl ViewerEngineMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Hybrid => "hybrid",
            Self::PpeOnly => "ppe-only",
        }
    }
}

const DEFAULT_VIEWER_ENGINE_MODE: ViewerEngineMode = ViewerEngineMode::Current;

fn parse_viewer_engine_mode(raw: &str) -> ViewerEngineMode {
    match raw.trim().to_ascii_lowercase().as_str() {
        "hybrid" => ViewerEngineMode::Hybrid,
        "ppe-only" | "ppe_only" => ViewerEngineMode::PpeOnly,
        _ => ViewerEngineMode::Current,
    }
}

pub fn viewer_engine_mode() -> ViewerEngineMode {
    std::env::var("PRYNX_VIEWER_ENGINE_MODE")
        .map(|raw| parse_viewer_engine_mode(&raw))
        .unwrap_or(DEFAULT_VIEWER_ENGINE_MODE)
}

fn parse_shadow_render_enabled(raw: Option<&str>) -> bool {
    raw.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn shadow_render_enabled_for_build(debug_build: bool, raw: Option<&str>) -> bool {
    // SEC (audit 2026-09-05 §LOG.01): shadow render là harness chẩn đoán,
    // không phải tính năng production. Env trên máy khách không được mở lại.
    debug_build && parse_shadow_render_enabled(raw)
}

pub fn viewer_shadow_render_enabled() -> bool {
    shadow_render_enabled_for_build(
        cfg!(debug_assertions),
        std::env::var("PRYNX_VIEWER_SHADOW_RENDER").ok().as_deref(),
    )
}

const DEFAULT_RENDER_WORKER_MODE: RenderWorkerMode = RenderWorkerMode::Auto;

fn parse_render_worker_mode(raw: &str) -> RenderWorkerMode {
    match raw.trim().to_ascii_lowercase().as_str() {
        "auto" => RenderWorkerMode::Auto,
        "required" => RenderWorkerMode::Required,
        _ => RenderWorkerMode::Off,
    }
}

pub fn render_worker_mode() -> RenderWorkerMode {
    std::env::var("PRYNX_RENDER_WORKER_MODE")
        .map(|raw| parse_render_worker_mode(&raw))
        .unwrap_or(DEFAULT_RENDER_WORKER_MODE)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkerLane {
    Interactive,
    Background(usize),
}

fn background_lane_count_for_hardware(total_ram_bytes: Option<u64>, parallelism: usize) -> usize {
    const GIB: u64 = 1024 * 1024 * 1024;
    match total_ram_bytes {
        Some(bytes) if bytes < 8 * GIB => 0,
        Some(bytes) if bytes < 16 * GIB => 1,
        // PERF (audit 2026-08-08 §RENDER.2): pool nền co theo cả CPU lẫn RAM vì mỗi
        // process có PDFium/doc/page/tile cache riêng. Đây không phải hard-cap cố định:
        // máy nhiều RAM tiếp tục tăng tới CPU-1, còn máy 16 GiB không bị phép tạo 15
        // process PDFium và tự đẩy mình vào swap/OOM.
        Some(bytes) => {
            let cpu_budget = parallelism.saturating_sub(1).max(1);
            let ram_budget = (bytes / (4 * GIB)).max(1) as usize;
            cpu_budget.min(ram_budget)
        }
        None => parallelism.saturating_sub(1).max(1),
    }
}

fn parse_background_lane_override(raw: Option<&str>) -> Option<usize> {
    raw.and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value <= 256)
}

fn configured_background_lane_count() -> usize {
    if let Ok(raw) = std::env::var("PRYNX_RENDER_BACKGROUND_WORKERS") {
        if let Some(value) = parse_background_lane_override(Some(&raw)) {
            return value;
        }
        log::warn!(
            "[RENDER_WORKER] Bỏ qua PRYNX_RENDER_BACKGROUND_WORKERS không hợp lệ: {}",
            raw
        );
    }
    background_lane_count_for_hardware(
        crate::system_total_memory_bytes(),
        std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
    )
}

#[cfg(test)]
fn render_request_slots_for_hardware(
    mode: RenderWorkerMode,
    total_ram_bytes: Option<u64>,
    parallelism: usize,
) -> usize {
    if mode == RenderWorkerMode::Off {
        // Giữ nguyên trần đường in-process cũ trong release có chủ ý tắt worker.
        return 4;
    }
    // Tier <8 GiB vẫn cần hai request đi vào parent: background đang mượn worker và
    // interactive mới phải tới manager để preempt nó. Các tier cao dùng đủ pool lazy.
    background_lane_count_for_hardware(total_ram_bytes, parallelism)
        .saturating_add(1)
        .max(2)
}

pub(crate) fn configured_render_request_slots() -> usize {
    if render_worker_mode() == RenderWorkerMode::Off {
        4
    } else {
        configured_background_lane_count().saturating_add(1).max(2)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum RenderWorkerFrameKind {
    Request = 1,
    Response = 2,
}

impl TryFrom<u16> for RenderWorkerFrameKind {
    type Error = RenderWorkerProtocolError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Request),
            2 => Ok(Self::Response),
            received => Err(RenderWorkerProtocolError::InvalidFrameKind(received)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameSection {
    Prefix,
    Header,
    Payload,
}

impl fmt::Display for FrameSection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Prefix => "tiền tố",
            Self::Header => "header JSON",
            Self::Payload => "payload",
        };
        formatter.write_str(name)
    }
}

#[derive(Debug)]
pub enum RenderWorkerProtocolError {
    Io(io::Error),
    Truncated {
        section: FrameSection,
        expected: usize,
        actual: usize,
    },
    InvalidMagic([u8; 4]),
    UnsupportedVersion {
        received: u16,
        supported: u16,
    },
    InvalidFrameKind(u16),
    HeaderLengthOutOfRange {
        length: u64,
        max: usize,
    },
    PayloadLengthOutOfRange {
        length: u64,
        max: u64,
    },
    HeaderJson(serde_json::Error),
}

impl fmt::Display for RenderWorkerProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Lỗi I/O protocol render worker: {error}"),
            Self::Truncated {
                section,
                expected,
                actual,
            } => write!(
                formatter,
                "Frame render worker bị cắt ở {section}: cần {expected} byte, nhận {actual} byte"
            ),
            Self::InvalidMagic(received) => {
                write!(formatter, "Magic render worker không hợp lệ: {received:?}")
            }
            Self::UnsupportedVersion {
                received,
                supported,
            } => write!(
                formatter,
                "Protocol render worker phiên bản {received} không được hỗ trợ; cần phiên bản {supported}"
            ),
            Self::InvalidFrameKind(received) => {
                write!(formatter, "Loại frame render worker không hợp lệ: {received}")
            }
            Self::HeaderLengthOutOfRange { length, max } => write!(
                formatter,
                "Header render worker dài {length} byte, ngoài giới hạn 1..={max} byte"
            ),
            Self::PayloadLengthOutOfRange { length, max } => write!(
                formatter,
                "Payload render worker dài {length} byte, vượt giới hạn {max} byte"
            ),
            Self::HeaderJson(error) => {
                write!(formatter, "Header JSON của render worker không hợp lệ: {error}")
            }
        }
    }
}

impl Error for RenderWorkerProtocolError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::HeaderJson(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for RenderWorkerProtocolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for RenderWorkerProtocolError {
    fn from(error: serde_json::Error) -> Self {
        Self::HeaderJson(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RenderWorkerFrame<H> {
    pub kind: RenderWorkerFrameKind,
    pub request_id: u64,
    pub header: H,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloRequest {
    pub request_id: String,
    pub parent_pid: u32,
    pub nonce: String,
    pub expected_app_version: String,
    pub expected_tile_cache_version: String,
    pub expected_pipeline_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloResponse {
    pub ok: bool,
    pub request_id: String,
    pub nonce: String,
    pub worker_pid: u32,
    pub protocol_version: u16,
    pub app_version: String,
    pub tile_cache_version: String,
    pub pipeline_identity: String,
    pub pdfium_sha256: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentRequest {
    pub request_id: String,
    pub owner_id: String,
    pub file_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataRequest {
    pub request_id: String,
    pub owner_id: String,
    pub file_path: String,
    pub expected_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccurateSessionOwnerRequest {
    pub request_id: String,
    pub session_owner_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelRequest {
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentResponse {
    pub request_id: String,
    pub owner_id: String,
    pub ok: bool,
    pub payload_encoding: Option<String>,
    pub closed: Option<bool>,
    pub total_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderDocumentIdentity {
    pub path: String,
    /// Dùng chuỗi để không mất độ chính xác `u64` khi request đi qua JavaScript.
    pub size_bytes: String,
    pub modified_nanos: String,
    pub created_nanos: String,
    pub token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderClip {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RenderRaster {
    Scale {
        scale: f32,
        clip: Option<RenderClip>,
    },
    Dpi {
        dpi: f32,
        clip: Option<RenderClip>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderPurpose {
    Interactive,
    Background,
    Accurate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerRenderContext {
    pub request_id: String,
    pub owner_id: String,
    pub group_key: String,
    pub generation: u64,
    pub purpose: RenderPurpose,
    pub priority: i32,
    pub pipeline_identity: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderColorPipeline {
    Display,
    Accurate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenderSoundness {
    DisplayPreview,
    ColorVerified,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderColor {
    pub pipeline: RenderColorPipeline,
    pub profile_id: Option<String>,
    pub intent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderRequest {
    pub request_id: String,
    pub owner_id: String,
    /// Owner vòng đời của tab/tài liệu; khác request owner theo layer/generation.
    pub session_owner_id: Option<String>,
    pub group_key: String,
    pub generation: u64,
    pub purpose: RenderPurpose,
    pub priority: i32,
    pub document: RenderDocumentIdentity,
    pub page: i32,
    pub rotation: i32,
    pub raster: RenderRaster,
    pub color: RenderColor,
    pub pipeline_identity: String,
    pub soundness: RenderSoundness,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderResponseStatus {
    Ready,
    Cancelled,
    Unsupported,
    Error,
}

/// Lý do PPE không được phép phát frame color-verified. Đây là giới hạn
/// capability có thể định tuyến sang compatibility lane, khác hẳn crash/I/O/OOM.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderUnsupportedReason {
    ImageCodec,
    KnockoutTransparency,
    UnsupportedTransparency,
    ColorApproximation,
    GeometryApproximation,
    HiddenContent,
    UnsupportedFeature,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderCacheTier {
    Ram,
    Disk,
    Rendered,
    None,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderTiming {
    pub queue_ms: u64,
    pub wait_ms: u64,
    pub render_ms: Option<u64>,
    pub encode_ms: Option<u64>,
    pub cache_ms: Option<u64>,
    pub total_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderResponse {
    pub request_id: String,
    pub owner_id: String,
    pub generation: u64,
    pub status: RenderResponseStatus,
    pub bitmap_width: Option<u32>,
    pub bitmap_height: Option<u32>,
    pub pipeline_identity: String,
    pub cache_tier: RenderCacheTier,
    pub timing: RenderTiming,
    pub soundness: RenderSoundness,
    pub unsupported_reason: Option<RenderUnsupportedReason>,
    /// Fingerprint font dự phòng được nhúng trong worker; không phụ thuộc font hệ thống.
    pub fallback_font_sha256: Option<String>,
    #[serde(default)]
    pub substituted_fonts: Vec<String>,
    #[serde(default)]
    pub geometry_approximated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "message", rename_all = "snake_case")]
pub enum RenderWorkerRequest {
    Hello(HelloRequest),
    Bootstrap(DocumentRequest),
    Metadata(MetadataRequest),
    CloseDocument(DocumentRequest),
    ReleaseAccurateSessionOwner(AccurateSessionOwnerRequest),
    Render(RenderRequest),
    Cancel(CancelRequest),
    Ping { nonce: String },
    Shutdown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "message", rename_all = "snake_case")]
pub enum RenderWorkerResponse {
    Hello(HelloResponse),
    Bootstrap(DocumentResponse),
    Metadata(DocumentResponse),
    CloseDocument(DocumentResponse),
    ReleaseAccurateSessionOwner(DocumentResponse),
    Render(RenderResponse),
    Pong { nonce: String, worker_pid: u32 },
    Shutdown { ok: bool },
}

/// PERF (audit 2026-08-08 §RENDER.2): header được kiểm xong trước khi ghi byte đầu tiên,
/// tránh để frame dở làm mất đồng bộ pipe nếu hợp đồng nội bộ vượt giới hạn.
pub fn write_frame<W, H>(
    writer: &mut W,
    kind: RenderWorkerFrameKind,
    request_id: u64,
    header: &H,
    payload: &[u8],
) -> Result<(), RenderWorkerProtocolError>
where
    W: Write,
    H: Serialize,
{
    let header_bytes = serde_json::to_vec(header)?;
    validate_lengths(header_bytes.len() as u64, payload.len() as u64)?;

    let header_len = u32::try_from(header_bytes.len()).map_err(|_| {
        RenderWorkerProtocolError::HeaderLengthOutOfRange {
            length: header_bytes.len() as u64,
            max: RENDER_WORKER_MAX_HEADER_BYTES,
        }
    })?;
    let payload_len = u64::try_from(payload.len()).map_err(|_| {
        RenderWorkerProtocolError::PayloadLengthOutOfRange {
            length: u64::MAX,
            max: RENDER_WORKER_MAX_PAYLOAD_BYTES,
        }
    })?;

    let mut prefix = [0_u8; RENDER_WORKER_FRAME_PREFIX_BYTES];
    prefix[0..4].copy_from_slice(&RENDER_WORKER_MAGIC);
    prefix[4..6].copy_from_slice(&RENDER_WORKER_PROTOCOL_VERSION.to_le_bytes());
    prefix[6..8].copy_from_slice(&(kind as u16).to_le_bytes());
    prefix[8..16].copy_from_slice(&request_id.to_le_bytes());
    prefix[16..20].copy_from_slice(&header_len.to_le_bytes());
    prefix[20..28].copy_from_slice(&payload_len.to_le_bytes());

    writer.write_all(&prefix)?;
    writer.write_all(&header_bytes)?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

/// Đọc đúng một frame. Mọi độ dài được kiểm trước khi cấp phát buffer tương ứng.
/// Lỗi protocol là lỗi fatal của stream; caller phải đóng/restart worker thay vì đọc tiếp.
pub fn read_frame<R, H>(reader: &mut R) -> Result<RenderWorkerFrame<H>, RenderWorkerProtocolError>
where
    R: Read,
    H: DeserializeOwned,
{
    let mut prefix = [0_u8; RENDER_WORKER_FRAME_PREFIX_BYTES];
    read_exact_section(reader, &mut prefix, FrameSection::Prefix)?;

    let received_magic = [prefix[0], prefix[1], prefix[2], prefix[3]];
    if received_magic != RENDER_WORKER_MAGIC {
        return Err(RenderWorkerProtocolError::InvalidMagic(received_magic));
    }

    let version = u16::from_le_bytes([prefix[4], prefix[5]]);
    if version != RENDER_WORKER_PROTOCOL_VERSION {
        return Err(RenderWorkerProtocolError::UnsupportedVersion {
            received: version,
            supported: RENDER_WORKER_PROTOCOL_VERSION,
        });
    }

    let kind = RenderWorkerFrameKind::try_from(u16::from_le_bytes(
        prefix[6..8].try_into().expect("slice dài cố định"),
    ))?;
    let request_id = u64::from_le_bytes(prefix[8..16].try_into().expect("slice dài cố định"));
    let header_len = u32::from_le_bytes(prefix[16..20].try_into().expect("slice dài cố định"));
    let payload_len = u64::from_le_bytes(prefix[20..28].try_into().expect("slice dài cố định"));
    validate_lengths(u64::from(header_len), payload_len)?;

    let mut header_bytes = vec![0_u8; header_len as usize];
    read_exact_section(reader, &mut header_bytes, FrameSection::Header)?;
    let header = serde_json::from_slice(&header_bytes)?;

    let payload_len_usize = usize::try_from(payload_len).map_err(|_| {
        RenderWorkerProtocolError::PayloadLengthOutOfRange {
            length: payload_len,
            max: RENDER_WORKER_MAX_PAYLOAD_BYTES,
        }
    })?;
    let mut payload = vec![0_u8; payload_len_usize];
    read_exact_section(reader, &mut payload, FrameSection::Payload)?;

    Ok(RenderWorkerFrame {
        kind,
        request_id,
        header,
        payload,
    })
}

fn validate_lengths(header_len: u64, payload_len: u64) -> Result<(), RenderWorkerProtocolError> {
    if header_len == 0 || header_len > RENDER_WORKER_MAX_HEADER_BYTES as u64 {
        return Err(RenderWorkerProtocolError::HeaderLengthOutOfRange {
            length: header_len,
            max: RENDER_WORKER_MAX_HEADER_BYTES,
        });
    }
    if payload_len > RENDER_WORKER_MAX_PAYLOAD_BYTES {
        return Err(RenderWorkerProtocolError::PayloadLengthOutOfRange {
            length: payload_len,
            max: RENDER_WORKER_MAX_PAYLOAD_BYTES,
        });
    }
    Ok(())
}

fn read_exact_section<R: Read>(
    reader: &mut R,
    buffer: &mut [u8],
    section: FrameSection,
) -> Result<(), RenderWorkerProtocolError> {
    let mut offset = 0;
    while offset < buffer.len() {
        match reader.read(&mut buffer[offset..]) {
            Ok(0) => {
                return Err(RenderWorkerProtocolError::Truncated {
                    section,
                    expected: buffer.len(),
                    actual: offset,
                });
            }
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return Err(RenderWorkerProtocolError::Truncated {
                    section,
                    expected: buffer.len(),
                    actual: offset,
                });
            }
            Err(error) => return Err(RenderWorkerProtocolError::Io(error)),
        }
    }
    Ok(())
}

fn valid_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > RENDER_WORKER_MAX_ID_BYTES {
        return Err(format!("{label} vượt giới hạn độ dài render worker."));
    }
    if value
        .chars()
        .any(|character| character == '\0' || character.is_control())
    {
        return Err(format!("{label} chứa ký tự điều khiển không hợp lệ."));
    }
    Ok(())
}

fn validate_clip(clip: Option<RenderClip>) -> Result<(), String> {
    let Some(clip) = clip else {
        return Ok(());
    };
    if clip.x < 0
        || clip.y < 0
        || !(1..=4000).contains(&clip.width)
        || !(1..=4000).contains(&clip.height)
    {
        return Err("Clip render worker ngoài miền 0..4000.".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn has_windows_alternate_stream(path: &str) -> bool {
    let bytes = path.as_bytes();
    let after_drive = if bytes.len() >= 2 && bytes[1] == b':' {
        &path[2..]
    } else {
        path
    };
    after_drive.contains(':')
}

#[cfg(not(windows))]
fn has_windows_alternate_stream(_path: &str) -> bool {
    false
}

fn validate_document_path(path: &str, expected_identity: Option<&str>) -> Result<String, String> {
    if path.is_empty() || path.len() > RENDER_WORKER_MAX_PATH_BYTES {
        return Err("Đường dẫn PDF render worker vượt giới hạn độ dài.".to_string());
    }
    let normalized_path = path.replace('/', "\\").to_ascii_lowercase();
    if normalized_path.starts_with("\\\\.\\")
        || normalized_path.starts_with("\\\\?\\globalroot\\")
        || normalized_path.starts_with("\\\\?\\pipe\\")
        || has_windows_alternate_stream(path)
    {
        return Err("Device namespace/ADS không được phép trong render worker.".to_string());
    }
    if crate::is_sensitive_path(path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let raw_path = Path::new(path);
    if !raw_path.is_absolute() {
        return Err("Đường dẫn PDF render worker phải là đường dẫn tuyệt đối.".to_string());
    }
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|error| format!("Không canonicalize được PDF render worker: {error}"))?;
    let canonical_string = canonical.to_string_lossy().into_owned();
    if crate::is_sensitive_path(&canonical_string) {
        return Err("Access to this location is not allowed".to_string());
    }
    if !canonical.is_file() {
        return Err("Đường dẫn PDF render worker không phải file thường.".to_string());
    }
    if let Some(expected) = expected_identity {
        let identity = crate::pdf_file_identity(&canonical_string)?;
        if crate::pdf_file_identity_token(identity) != expected {
            return Err("Identity PDF đã thay đổi trước khi worker xử lý.".to_string());
        }
    }
    Ok(canonical_string)
}

fn validate_render_request(request: &RenderRequest) -> Result<String, String> {
    valid_identifier(&request.request_id, "request_id")?;
    valid_identifier(&request.owner_id, "owner_id")?;
    valid_identifier(&request.group_key, "group_key")?;
    if let Some(session_owner_id) = request.session_owner_id.as_deref() {
        valid_identifier(session_owner_id, "session_owner_id")?;
    }
    let canonical_string =
        validate_document_path(&request.document.path, Some(&request.document.token))?;
    if request.page < 1 {
        return Err("Số trang render worker phải bắt đầu từ 1.".to_string());
    }
    if !matches!(request.rotation, 0 | 90 | 180 | 270) {
        return Err("Góc xoay render worker chỉ nhận 0/90/180/270.".to_string());
    }
    match (request.color.pipeline, request.raster) {
        (RenderColorPipeline::Display, RenderRaster::Scale { scale, clip }) => {
            if !scale.is_finite() || scale <= 0.0 {
                return Err("Scale render worker phải hữu hạn và lớn hơn 0.".to_string());
            }
            validate_clip(clip)?;
            if request.color.profile_id.is_some()
                || request.color.intent.is_some()
                || request.session_owner_id.is_some()
                || request.pipeline_identity != RENDER_WORKER_DISPLAY_PIPELINE_ID
                || request.soundness != RenderSoundness::DisplayPreview
            {
                return Err("Display worker chỉ nhận pipeline PDFium display.".to_string());
            }
        }
        (RenderColorPipeline::Accurate, RenderRaster::Dpi { dpi, clip }) => {
            if !dpi.is_finite() || !(24.0..=9600.0).contains(&dpi) {
                return Err("DPI PPE render worker phải nằm trong 24..9600.".to_string());
            }
            validate_clip(clip)?;
            if request.color.profile_id.as_deref() != Some(PPE_WORKER_PROFILE_ID) {
                return Err("PPE worker chỉ nhận profile fogra39 đã được pin.".to_string());
            }
            if request.color.intent.as_deref() != Some(PPE_WORKER_INTENT) {
                return Err("PPE worker chỉ nhận rendering intent relative.".to_string());
            }
            if request.session_owner_id.is_none() {
                return Err("PPE worker thiếu session_owner_id của tab/tài liệu.".to_string());
            }
            if request.pipeline_identity != RENDER_WORKER_ACCURATE_PIPELINE_ID
                || request.soundness != RenderSoundness::ColorVerified
            {
                return Err("PPE worker yêu cầu pipeline accurate color-verified.".to_string());
            }
        }
        (RenderColorPipeline::Display, RenderRaster::Dpi { .. }) => {
            return Err("PDFium display không nhận raster DPI của PPE.".to_string());
        }
        (RenderColorPipeline::Accurate, RenderRaster::Scale { .. }) => {
            return Err("PPE accurate không nhận scale PDFium.".to_string());
        }
    }
    Ok(canonical_string)
}

fn png_dimensions(bytes: &[u8]) -> (Option<u32>, Option<u32>) {
    if bytes.len() >= 24
        && bytes[0..8] == [137, 80, 78, 71, 13, 10, 26, 10]
        && &bytes[12..16] == b"IHDR"
    {
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap_or([0; 4]));
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap_or([0; 4]));
        return (Some(width), Some(height));
    }
    (None, None)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Không đọc được PDFium để pin hash: {error}"))?;
    let mut hasher = sha2::Sha256::new();
    // Heap buffer: main thread Windows có stack nhỏ; mảng 1 MiB trên stack từng làm
    // worker chết STATUS_STACK_OVERFLOW ngay trong handshake thật.
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Không hash được PDFium: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn pdfium_sha256() -> Result<Option<String>, String> {
    let identity = crate::current_pdfium_runtime_identity();
    if identity.library_path == "unknown" || identity.library_path == "system-library-search" {
        return Ok(None);
    }
    sha256_file(Path::new(&identity.library_path)).map(Some)
}

fn expected_pdfium_sha256() -> Result<Option<String>, String> {
    let mut directories = Vec::<PathBuf>::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            directories.push(parent.to_path_buf());
            directories.push(parent.join("bin"));
        }
    }
    if let Ok(current) = std::env::current_dir() {
        directories.push(current.join("bin"));
        directories.push(current);
    }
    for directory in directories {
        let candidate =
            pdfium_render::prelude::Pdfium::pdfium_platform_library_name_at_path(&directory);
        if candidate.is_file() {
            return sha256_file(&candidate).map(Some);
        }
    }
    Ok(None)
}

fn hello_response(request: HelloRequest) -> HelloResponse {
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let tile_cache_version = crate::TILE_RENDER_CACHE_VERSION.to_string();
    let mut error = None;
    if let Err(message) = valid_identifier(&request.request_id, "request_id") {
        error = Some(message);
    } else if request.nonce.is_empty() || request.nonce.len() > RENDER_WORKER_MAX_ID_BYTES {
        error = Some("Nonce handshake render worker không hợp lệ.".to_string());
    } else if request.expected_app_version != app_version {
        error = Some("Phiên bản app của render worker không khớp.".to_string());
    } else if request.expected_tile_cache_version != tile_cache_version {
        error = Some("Phiên bản tile cache của render worker không khớp.".to_string());
    } else if request.expected_pipeline_identity != RENDER_WORKER_DISPLAY_PIPELINE_ID {
        error = Some("Pipeline display worker không khớp.".to_string());
    }

    let pdfium_sha256 = if error.is_none() {
        match crate::ensure_pdfium().and_then(|_| pdfium_sha256()) {
            Ok(hash) => hash,
            Err(message) => {
                error = Some(message);
                None
            }
        }
    } else {
        None
    };
    HelloResponse {
        ok: error.is_none(),
        request_id: request.request_id,
        nonce: request.nonce,
        worker_pid: std::process::id(),
        protocol_version: RENDER_WORKER_PROTOCOL_VERSION,
        app_version,
        tile_cache_version,
        pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
        pdfium_sha256,
        error,
    }
}

fn document_json_response(
    request_id: String,
    owner_id: String,
    file_path: String,
    expected_identity: Option<String>,
    metadata: bool,
) -> (DocumentResponse, Vec<u8>) {
    let started = Instant::now();
    let result = (|| -> Result<Vec<u8>, String> {
        valid_identifier(&request_id, "request_id")?;
        valid_identifier(&owner_id, "owner_id")?;
        if let Some(expected) = expected_identity.as_deref() {
            valid_identifier(expected, "expected_identity")?;
        }
        let canonical = validate_document_path(&file_path, expected_identity.as_deref())?;
        let value = if metadata {
            crate::pdf_metadata_in_process(&canonical, expected_identity.as_deref())?
        } else {
            crate::viewer_bootstrap_in_process(&canonical)?
        };
        serde_json::to_vec(&value)
            .map_err(|error| format!("Không serialize được metadata worker: {error}"))
    })();
    match result {
        Ok(payload) => (
            DocumentResponse {
                request_id,
                owner_id,
                ok: true,
                payload_encoding: Some("json-utf8".to_string()),
                closed: None,
                total_ms: started.elapsed().as_millis() as u64,
                error: None,
            },
            payload,
        ),
        Err(error) => (
            DocumentResponse {
                request_id,
                owner_id,
                ok: false,
                payload_encoding: None,
                closed: None,
                total_ms: started.elapsed().as_millis() as u64,
                error: Some(error),
            },
            Vec::new(),
        ),
    }
}

fn close_document_response(request: DocumentRequest) -> DocumentResponse {
    let started = Instant::now();
    let result = (|| -> Result<bool, String> {
        valid_identifier(&request.request_id, "request_id")?;
        valid_identifier(&request.owner_id, "owner_id")?;
        let canonical = validate_document_path(&request.file_path, None)?;
        let display_closed = crate::close_pdf_document_in_process(&canonical)?;
        let accurate_closed = close_accurate_sessions_for_path(&canonical);
        Ok(display_closed || accurate_closed)
    })();
    match result {
        Ok(closed) => DocumentResponse {
            request_id: request.request_id,
            owner_id: request.owner_id,
            ok: true,
            payload_encoding: None,
            closed: Some(closed),
            total_ms: started.elapsed().as_millis() as u64,
            error: None,
        },
        Err(error) => DocumentResponse {
            request_id: request.request_id,
            owner_id: request.owner_id,
            ok: false,
            payload_encoding: None,
            closed: None,
            total_ms: started.elapsed().as_millis() as u64,
            error: Some(error),
        },
    }
}

fn release_accurate_session_owner_response(
    request: AccurateSessionOwnerRequest,
) -> DocumentResponse {
    let started = Instant::now();
    let result = (|| -> Result<bool, String> {
        valid_identifier(&request.request_id, "request_id")?;
        valid_identifier(&request.session_owner_id, "session_owner_id")?;
        Ok(release_accurate_session_owner(&request.session_owner_id))
    })();
    match result {
        Ok(released) => DocumentResponse {
            request_id: request.request_id,
            owner_id: request.session_owner_id,
            ok: true,
            payload_encoding: None,
            closed: Some(released),
            total_ms: started.elapsed().as_millis() as u64,
            error: None,
        },
        Err(error) => DocumentResponse {
            request_id: request.request_id,
            owner_id: request.session_owner_id,
            ok: false,
            payload_encoding: None,
            closed: None,
            total_ms: started.elapsed().as_millis() as u64,
            error: Some(error),
        },
    }
}

struct AccurateWorkerOutput {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    render_ms: u64,
    encode_ms: u64,
    cache_ms: u64,
    substituted_fonts: Vec<String>,
    geometry_approximated: bool,
}

enum AccurateWorkerFailure {
    Cancelled,
    Unsupported {
        reason: RenderUnsupportedReason,
        detail: String,
    },
    Error(String),
}

fn classify_unsupported_warnings(
    warnings: &RenderWarnings,
) -> Option<(RenderUnsupportedReason, &'static str)> {
    let skipped = |needle: &str| {
        warnings
            .skipped_ops
            .iter()
            .any(|(operation, _)| operation.contains(needle))
    };
    if skipped("JPXDecode") || skipped("JBIG2Decode") {
        return Some((
            RenderUnsupportedReason::ImageCodec,
            "Trang dùng codec ảnh PPE chưa giải mã được.",
        ));
    }
    if skipped("Group /K true") {
        return Some((
            RenderUnsupportedReason::KnockoutTransparency,
            "Trang dùng transparency group knockout PPE chưa dựng exact.",
        ));
    }
    if warnings.unsupported_transparency {
        return Some((
            RenderUnsupportedReason::UnsupportedTransparency,
            "Trang dùng transparency PPE chưa dựng exact.",
        ));
    }
    if !warnings.approximated_colorspaces.is_empty() {
        return Some((
            RenderUnsupportedReason::ColorApproximation,
            "Trang cần phép màu xấp xỉ nên không được gắn color-verified.",
        ));
    }
    if warnings.hidden_content_risk {
        return Some((
            RenderUnsupportedReason::HiddenContent,
            "Trạng thái nội dung ẩn của trang chưa được xác minh đầy đủ.",
        ));
    }
    // COLOR (audit 2026-08-19 §BXC.2): font dự phòng chỉ hạ độ chính xác HÌNH
    // HỌC; PPE vẫn đã dựng đủ pixel qua đúng pipeline mực/ICC. Loại cả PNG ở đây
    // làm Viewer hoặc trắng trang, hoặc phải đổi sang PDFium và đổi màu toàn bộ.
    // Vì vậy geometry-only không phải capability failure của preview màu.
    if warnings.dropped_objects > 0 {
        return Some((
            RenderUnsupportedReason::UnsupportedFeature,
            "Trang có đối tượng PPE chưa dựng được.",
        ));
    }
    None
}

impl From<String> for AccurateWorkerFailure {
    fn from(error: String) -> Self {
        Self::Error(error)
    }
}

impl From<PpeError> for AccurateWorkerFailure {
    fn from(error: PpeError) -> Self {
        match error {
            PpeError::Cancelled => Self::Cancelled,
            PpeError::Unsupported(detail) => Self::Unsupported {
                reason: RenderUnsupportedReason::UnsupportedFeature,
                detail,
            },
            other => Self::Error(other.to_string()),
        }
    }
}

fn trace_worker_cpu(_request_id: &str, _stage: &str, _render_budget: usize, _cache_budget: usize) {
    #[cfg(all(windows, debug_assertions))]
    {
        static ENABLED: OnceLock<bool> = OnceLock::new();
        if !*ENABLED.get_or_init(|| std::env::var("PRYNX_WORKER_CPU_PROBE").as_deref() == Ok("1")) {
            return;
        }
        // Chỉ đọc CPU/thread hiện tại, không đổi affinity hoặc priority của hệ thống.
        let (cpu, thread) = unsafe {
            (windows::Win32::System::Threading::GetCurrentProcessorNumber(),
             windows::Win32::System::Threading::GetCurrentThreadId())
        };
        crate::perf_log(&format!(
            "PPE_CPU_PROBE pid={} thread={thread} cpu={cpu} stage={_stage} request_id={_request_id} render_budget={_render_budget} cache_budget={_cache_budget}",
            std::process::id()));
    }
}

fn serial_document_affinity_for_build(debug_build: bool, raw: Option<&str>) -> bool {
    // PERF (audit 2026-09-23 §R23.02): thử nghiệm chỉ trong dev. Benchmark cho
    // thấy cùng session mutable giảm cold thumbnail nhưng tuần tự hóa raster,
    // làm prefetch chậm hơn. Chưa được promote trước khi có snapshot song song.
    debug_build && raw.is_some_and(|value| value.trim() == "1")
}

fn serial_document_affinity_enabled() -> bool {
    serial_document_affinity_for_build(cfg!(debug_assertions),
        std::env::var("PRYNX_PPE_SERIAL_DOCUMENT_AFFINITY").ok().as_deref())
}

fn render_accurate_png(
    path: &str,
    request: &RenderRequest,
    cancel_token: &CancelToken,
) -> Result<AccurateWorkerOutput, AccurateWorkerFailure> {
    cancel_token.check()?;
    let RenderRaster::Dpi { dpi, clip } = request.raster else {
        return Err("PPE worker không nhận raster scale.".to_string().into());
    };
    let profile_id = request
        .color
        .profile_id
        .as_deref()
        .ok_or_else(|| "PPE worker thiếu profile màu.".to_string())?;
    let profile_path = accurate_profile_path(profile_id)?;
    let intent = match request.color.intent.as_deref() {
        Some(PPE_WORKER_INTENT) => RenderIntent::RelativeColorimetric,
        _ => {
            return Err("PPE worker chỉ nhận rendering intent relative."
                .to_string()
                .into())
        }
    };
    let key = AccurateSessionKey {
        document_path: path.to_string(),
        document_token: request.document.token.clone(),
        profile_path: profile_path.clone(),
        intent: PPE_WORKER_INTENT.to_string(),
    };
    let raster_clip = clip.map(|value| RasterClip {
        x: value.x as u32,
        y: value.y as u32,
        width: value.width as u32,
        height: value.height as u32,
    });
    let session_owner_id = request
        .session_owner_id
        .as_deref()
        .ok_or_else(|| "PPE worker thiếu session_owner_id.".to_string())?;
    let (render_budget, cache_budget) = accurate_worker_budgets();
    trace_worker_cpu(&request.request_id, "start", render_budget, cache_budget);
    let mut pool = accurate_sessions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    for entry in pool.entries.values_mut() {
        entry.owners.prune_stale(now, ACCURATE_SESSION_OWNER_TTL);
    }
    close_ownerless_accurate_sessions(&mut pool);
    // PERF/COLOR (audit 2026-08-09 §L3A): save-over cùng path không được giữ
    // session revision cũ trong worker. Tài liệu khác vẫn giữ cache riêng.
    pool.entries.retain(|existing, entry| {
        let keep =
            existing.document_path != path || existing.document_token == request.document.token;
        if !keep {
            entry.session.close();
        }
        keep
    });
    let status = crate::system_memory_status();
    let limit = accurate_session_limit_for_hardware(
        status.map(|value| value.total_bytes),
        status.map(|value| value.available_bytes),
    );
    if !pool.entries.contains_key(&key) {
        if let Some(limit) = limit {
            while pool.entries.len() >= limit.max(1) {
                let Some(oldest) = pool
                    .entries
                    .iter()
                    .filter(|(_key, entry)| entry.owners.is_empty()
                        && entry.in_flight.load(Ordering::Acquire) == 0)
                    .min_by_key(|(_key, entry)| entry.last_used)
                    .map(|(key, _entry)| key.clone())
                else {
                    break;
                };
                if let Some(mut evicted) = pool.entries.remove(&oldest) {
                    evicted.session.close();
                }
            }
        }
    }
    let transient = !pool.entries.contains_key(&key)
        && limit.is_some_and(|value| pool.entries.len() >= value.max(1));
    let cache_mode = if transient { "transient" } else { "session" };
    let mut cache_stats = (0_u64, 0_u64, 0_u64, 0_u64, 0_u64, 0_u64);
    let options = || {
        RenderOptions::softproof()
            // COLOR (feedback 2026-08-10 §VIEWER.C1): Viewer thường phải giống
            // Acrobat Page Display, không tự bật chế độ Output Preview. File không
            // phải PDF/X của khách có overprint; mô phỏng nó làm nền xanh bị tối và
            // co dải sáng. Công cụ Output Preview vẫn truyền `true` ở đường riêng.
            .with_overprint_simulation(false)
            // CORRECTNESS (audit 2026-08-10 §L6.2): Viewer phải đọc `/View`;
            // separations/TAC tiếp tục dùng mặc định `/Print` trong core.
            .with_optional_content_usage(OptionalContentUsage::View)
            .with_annotations(true)
            // CORRECTNESS (audit 2026-08-10 §L6.6): font dự phòng nằm trong
            // binary và có fingerprint cố định; không phụ thuộc font hệ thống.
            // Kết quả dùng font này vẫn bị gắn GeometryApproximation bên dưới.
            .with_fallback_font(ppe_fallback_font())
            .with_fallback_bold_font(ppe_fallback_bold_font())
            .with_memory_budget_bytes(render_budget)
            .with_cancel_token(cancel_token.clone())
    };
    let (job, _transient_session, session_flight) = if transient {
        // PERF (audit 2026-08-09 §L3C): máy ít RAM không đóng session của tab còn
        // sống để nhường chỗ. Tài liệu vượt pool chạy transient cache 0; chất lượng/DPI
        // giữ nguyên, chỉ lượt sau phải decode lại.
        drop(pool);
        let mut session =
            RenderSession::open_with_profile_paths(path, Some(&profile_path), None, intent)
                .map_err(|error| format!("Không mở được PPE RenderSession: {error}"))?
                .with_resource_cache_budget(0);
        let job = session.prepare_page_render(
            request.page as usize,
            dpi,
            PageBox::Crop,
            options(),
            raster_clip,
        )?;
        // Giữ owner transient sống tới sau encode/post-check; drop sớm sẽ retire
        // snapshot trước khi job bắt đầu raster.
        (job, Some(session), None)
    } else {
        if !pool.entries.contains_key(&key) {
            let session =
                RenderSession::open_with_profile_paths(path, Some(&profile_path), None, intent)
                    .map_err(|error| format!("Không mở được PPE RenderSession: {error}"))?
                    .with_resource_cache_budget(cache_budget);
            pool.entries.insert(
                key.clone(),
                AccurateSessionEntry {
                    session,
                    last_used: 0,
                    owners: AccurateOwnerLeases::default(),
                    in_flight: Arc::new(AtomicUsize::new(0)),
                },
            );
        }
        pool.sequence = pool.sequence.wrapping_add(1).max(1);
        let last_used = pool.sequence;
        let entry = pool
            .entries
            .get_mut(&key)
            .expect("PPE session vừa được chèn phải tồn tại");
        entry.last_used = last_used;
        entry.owners.bind(session_owner_id, now);
        let job = entry.session.prepare_page_render(
            request.page as usize,
            dpi,
            PageBox::Crop,
            options(),
            raster_clip,
        )?;
        entry.in_flight.fetch_add(1, Ordering::AcqRel);
        let flight = AccurateRequestLease(Arc::clone(&entry.in_flight));
        drop(pool);
        (job, None, Some(flight))
    };
    // PERF (audit 2026-09-23 §R23.02): registry chỉ giữ trong lúc lấy snapshot.
    // Raster/quy màu/encode không giữ pool, các tài liệu/owner khác vẫn truy cập
    // được. Chưa đổi stdio/client sang multiplex hoặc tăng số tác vụ đồng thời.
    let render_result = job.render_srgb();
    if let Some(flight) = &session_flight {
        let pool = accurate_sessions().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = pool.entries.get(&key).filter(|entry| Arc::ptr_eq(&entry.in_flight, &flight.0)) {
            let stats = entry.session.resource_cache_stats();
            cache_stats = (
                stats.image_hits,
                stats.image_misses,
                stats.form_hits,
                stats.form_misses,
                stats.page_hits,
                stats.page_misses,
            );
        }
    }
    let (rendered, timings) = match render_result {
        Ok(result) => result,
        Err(PpeError::Cancelled) => return Err(AccurateWorkerFailure::Cancelled),
        Err(PpeError::Unsupported(detail)) => {
            return Err(AccurateWorkerFailure::Unsupported {
                reason: RenderUnsupportedReason::UnsupportedFeature,
                detail,
            })
        }
        Err(error) => {
            return Err(AccurateWorkerFailure::Error(format!(
                "PPE render worker không dựng được trang: {error}"
            )))
        }
    };
    trace_worker_cpu(&request.request_id, "render-done", render_budget, cache_budget);
    crate::perf_log(&format!(
        "PPE_SESSION_CACHE request_id={} page={} mode={} image_hits={} image_misses={} form_hits={} form_misses={} page_hits={} page_misses={}",
        request.request_id,
        request.page,
        cache_mode,
        cache_stats.0,
        cache_stats.1,
        cache_stats.2,
        cache_stats.3,
        cache_stats.4,
        cache_stats.5,
    ));
    cancel_token.check()?;
    if let Some((reason, detail)) = classify_unsupported_warnings(&rendered.warnings) {
        return Err(AccurateWorkerFailure::Unsupported {
            reason,
            detail: detail.to_string(),
        });
    }
    if rendered.warnings.ink_unsound() {
        return Err(AccurateWorkerFailure::Error(
            "PPE phát hiện trạng thái màu/nội dung giảm độ tin cậy chưa được phân loại."
                .to_string(),
        ));
    }
    let encode_started = Instant::now();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            &rendered.rgb,
            rendered.width,
            rendered.height,
            ColorType::Rgb8.into(),
        )
        .map_err(|error| format!("Không encode được PNG PPE: {error}"))?;
    trace_worker_cpu(&request.request_id, "encode-done", render_budget, cache_budget);
    job.ensure_current()?;
    // Validate lại đường vào gốc; `path` nội bộ đã canonical hóa có thể mang
    // tiền tố \\?\ trên Windows, không được đưa trở lại bộ lọc input công khai.
    let current_path = validate_document_path(&request.document.path, Some(&request.document.token))?;
    if current_path != path {
        return Err("Đích PDF đã thay đổi trong lúc raster/encode.".to_string().into());
    }
    let render_ms =
        (timings.open + timings.parse + timings.raster + timings.color).as_millis() as u64;
    let substituted_fonts = rendered.warnings.substituted_fonts.clone();
    let geometry_approximated = rendered.warnings.geometry_approximate();
    Ok(AccurateWorkerOutput {
        bytes,
        width: rendered.width,
        height: rendered.height,
        render_ms,
        encode_ms: encode_started.elapsed().as_millis() as u64,
        cache_ms: timings.resource.as_millis() as u64,
        substituted_fonts,
        geometry_approximated,
    })
}

fn render_response(
    request: RenderRequest,
    cancel_token: Option<&CancelToken>,
) -> (RenderResponse, Vec<u8>) {
    let base_with_fonts =
        |status, unsupported_reason, error, bitmap_width, bitmap_height, timing, cache_tier, substituted_fonts: Vec<String>, geometry_approximated: bool| {
            RenderResponse {
                request_id: request.request_id.clone(),
                owner_id: request.owner_id.clone(),
                generation: request.generation,
                status,
                bitmap_width,
                bitmap_height,
                pipeline_identity: request.pipeline_identity.clone(),
                cache_tier,
                timing,
                soundness: request.soundness,
                unsupported_reason,
                fallback_font_sha256: (request.color.pipeline == RenderColorPipeline::Accurate)
                    .then(|| PPE_FALLBACK_FONT_SHA256.to_string()),
                substituted_fonts,
                geometry_approximated,
                error,
            }
        };
    let base =
        |status, unsupported_reason, error, bitmap_width, bitmap_height, timing, cache_tier| {
            base_with_fonts(
                status,
                unsupported_reason,
                error,
                bitmap_width,
                bitmap_height,
                timing,
                cache_tier,
                Vec::new(),
                false,
            )
        };
    let started = Instant::now();
    let path = match validate_render_request(&request) {
        Ok(path) => path,
        Err(error) => {
            return (
                base(
                    RenderResponseStatus::Error,
                    None,
                    Some(error),
                    None,
                    None,
                    RenderTiming {
                        total_ms: started.elapsed().as_millis() as u64,
                        ..Default::default()
                    },
                    RenderCacheTier::None,
                ),
                Vec::new(),
            );
        }
    };
    if request.color.pipeline == RenderColorPipeline::Accurate {
        let owned_token;
        let cancel_token = match cancel_token {
            Some(token) => token,
            None => {
                owned_token = CancelToken::new();
                &owned_token
            }
        };
        return match render_accurate_png(&path, &request, cancel_token) {
            Ok(output) => {
                let total_ms = started.elapsed().as_millis() as u64;
                (
                    base_with_fonts(
                        RenderResponseStatus::Ready,
                        None,
                        None,
                        Some(output.width),
                        Some(output.height),
                        RenderTiming {
                            render_ms: Some(output.render_ms),
                            encode_ms: Some(output.encode_ms),
                            cache_ms: Some(output.cache_ms),
                            total_ms,
                            ..Default::default()
                        },
                        RenderCacheTier::Rendered,
                        output.substituted_fonts,
                        output.geometry_approximated,
                    ),
                    output.bytes,
                )
            }
            Err(AccurateWorkerFailure::Cancelled) => (
                base(
                    RenderResponseStatus::Cancelled,
                    None,
                    None,
                    None,
                    None,
                    RenderTiming {
                        total_ms: started.elapsed().as_millis() as u64,
                        ..Default::default()
                    },
                    RenderCacheTier::None,
                ),
                Vec::new(),
            ),
            Err(AccurateWorkerFailure::Unsupported { reason, detail }) => (
                base(
                    RenderResponseStatus::Unsupported,
                    Some(reason),
                    Some(detail),
                    None,
                    None,
                    RenderTiming {
                        total_ms: started.elapsed().as_millis() as u64,
                        ..Default::default()
                    },
                    RenderCacheTier::None,
                ),
                Vec::new(),
            ),
            Err(AccurateWorkerFailure::Error(error)) => (
                base(
                    RenderResponseStatus::Error,
                    None,
                    Some(error),
                    None,
                    None,
                    RenderTiming {
                        total_ms: started.elapsed().as_millis() as u64,
                        ..Default::default()
                    },
                    RenderCacheTier::None,
                ),
                Vec::new(),
            ),
        };
    }
    let (zoom, clip) = match request.raster {
        RenderRaster::Scale { scale, clip } => (
            scale,
            clip.map(|value| {
                (
                    Some(value.x),
                    Some(value.y),
                    Some(value.width),
                    Some(value.height),
                )
            }),
        ),
        RenderRaster::Dpi { .. } => unreachable!("PPE DPI đã tách ở nhánh accurate"),
    };
    let render_result = crate::render_tile_png_with_timing(
        &path,
        request.page,
        zoom,
        request.rotation,
        clip.and_then(|value| value.0),
        clip.and_then(|value| value.1),
        clip.and_then(|value| value.2),
        clip.and_then(|value| value.3),
    );
    match render_result {
        Ok((bytes, breakdown)) => {
            let (width, height) = png_dimensions(&bytes);
            (
                base(
                    RenderResponseStatus::Ready,
                    None,
                    None,
                    width,
                    height,
                    RenderTiming {
                        render_ms: Some(breakdown.pdfium_render_ms + breakdown.convert_ms),
                        encode_ms: Some(breakdown.encode_ms),
                        cache_ms: Some(breakdown.cache_ms),
                        total_ms: started.elapsed().as_millis() as u64,
                        ..Default::default()
                    },
                    // Core raw chưa trả cache tier; không gắn nhãn Rendered sai cho RAM/disk hit.
                    RenderCacheTier::None,
                ),
                bytes,
            )
        }
        Err(error) => (
            base(
                RenderResponseStatus::Error,
                None,
                Some(error),
                None,
                None,
                RenderTiming {
                    total_ms: started.elapsed().as_millis() as u64,
                    ..Default::default()
                },
                RenderCacheTier::None,
            ),
            Vec::new(),
        ),
    }
}

enum WorkerInput {
    Frame {
        frame: RenderWorkerFrame<RenderWorkerRequest>,
        cancel_token: Option<CancelToken>,
    },
    Eof,
    Fatal(String),
}

fn cancel_worker_token(
    active_tokens: &Mutex<HashMap<String, CancelToken>>,
    request_id: &str,
) -> bool {
    let token = active_tokens
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .cloned();
    token.is_some_and(|token| token.cancel())
}

fn read_worker_input(
    sender: mpsc::Sender<WorkerInput>,
    active_tokens: Arc<Mutex<HashMap<String, CancelToken>>>,
) {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    loop {
        let frame = match read_frame::<_, RenderWorkerRequest>(&mut reader) {
            Ok(frame) => frame,
            Err(RenderWorkerProtocolError::Truncated {
                section: FrameSection::Prefix,
                actual: 0,
                ..
            }) => {
                let _ = sender.send(WorkerInput::Eof);
                return;
            }
            Err(error) => {
                let _ = sender.send(WorkerInput::Fatal(error.to_string()));
                return;
            }
        };
        if frame.kind != RenderWorkerFrameKind::Request {
            let _ = sender.send(WorkerInput::Fatal(
                "nhận response frame ở stdin".to_string(),
            ));
            return;
        }
        if !frame.payload.is_empty() {
            let _ = sender.send(WorkerInput::Fatal(
                "request frame không được mang payload".to_string(),
            ));
            return;
        }
        if let RenderWorkerRequest::Cancel(request) = &frame.header {
            cancel_worker_token(&active_tokens, &request.request_id);
            continue;
        }
        let cancel_token = match &frame.header {
            RenderWorkerRequest::Render(request)
                if request.color.pipeline == RenderColorPipeline::Accurate =>
            {
                let token = CancelToken::new();
                let mut active = active_tokens
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if active.contains_key(&request.request_id) {
                    let _ = sender.send(WorkerInput::Fatal(format!(
                        "request_id PPE đang render bị trùng: {}",
                        request.request_id
                    )));
                    return;
                }
                active.insert(request.request_id.clone(), token.clone());
                Some(token)
            }
            _ => None,
        };
        if sender
            .send(WorkerInput::Frame {
                frame,
                cancel_token,
            })
            .is_err()
        {
            return;
        }
    }
}

/// Entry dài hạn của worker. stdout chỉ ghi frame; chẩn đoán đi stderr/file log.
pub fn run_worker_stdio() -> i32 {
    super::worker_qos::configure();
    start_accurate_session_sweeper();
    let active_tokens = Arc::new(Mutex::new(HashMap::<String, CancelToken>::new()));
    let (input_sender, input_receiver) = mpsc::channel();
    let reader_tokens = Arc::clone(&active_tokens);
    if std::thread::Builder::new()
        .name("prynx-render-worker-control".to_string())
        .spawn(move || read_worker_input(input_sender, reader_tokens))
        .is_err()
    {
        eprintln!("[PXRW] không khởi tạo được luồng đọc lệnh");
        return 2;
    }
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let mut handshaken = false;
    loop {
        let (frame, cancel_token) = match input_receiver.recv() {
            Ok(WorkerInput::Frame {
                frame,
                cancel_token,
            }) => (frame, cancel_token),
            Ok(WorkerInput::Eof) | Err(_) => return 0,
            Ok(WorkerInput::Fatal(error)) => {
                eprintln!("[PXRW] protocol fatal: {error}");
                return 2;
            }
        };
        if frame.kind != RenderWorkerFrameKind::Request {
            eprintln!("[PXRW] nhận response frame ở stdin");
            return 2;
        }
        if !frame.payload.is_empty() {
            eprintln!("[PXRW] request frame không được mang payload");
            return 2;
        }
        match frame.header {
            RenderWorkerRequest::Hello(request) => {
                let response = hello_response(request);
                let ok = response.ok;
                if write_frame(
                    &mut writer,
                    RenderWorkerFrameKind::Response,
                    frame.request_id,
                    &RenderWorkerResponse::Hello(response),
                    &[],
                )
                .is_err()
                {
                    return 3;
                }
                if !ok {
                    return 4;
                }
                handshaken = true;
            }
            RenderWorkerRequest::Bootstrap(request) => {
                let (response, payload) = if handshaken {
                    document_json_response(
                        request.request_id,
                        request.owner_id,
                        request.file_path,
                        None,
                        false,
                    )
                } else {
                    (
                        DocumentResponse {
                            request_id: request.request_id,
                            owner_id: request.owner_id,
                            ok: false,
                            payload_encoding: None,
                            closed: None,
                            total_ms: 0,
                            error: Some("Worker chưa handshake.".to_string()),
                        },
                        Vec::new(),
                    )
                };
                if write_frame(
                    &mut writer,
                    RenderWorkerFrameKind::Response,
                    frame.request_id,
                    &RenderWorkerResponse::Bootstrap(response),
                    &payload,
                )
                .is_err()
                {
                    return 3;
                }
            }
            RenderWorkerRequest::Metadata(request) => {
                let (response, payload) = if handshaken {
                    document_json_response(
                        request.request_id,
                        request.owner_id,
                        request.file_path,
                        Some(request.expected_identity),
                        true,
                    )
                } else {
                    (
                        DocumentResponse {
                            request_id: request.request_id,
                            owner_id: request.owner_id,
                            ok: false,
                            payload_encoding: None,
                            closed: None,
                            total_ms: 0,
                            error: Some("Worker chưa handshake.".to_string()),
                        },
                        Vec::new(),
                    )
                };
                if write_frame(
                    &mut writer,
                    RenderWorkerFrameKind::Response,
                    frame.request_id,
                    &RenderWorkerResponse::Metadata(response),
                    &payload,
                )
                .is_err()
                {
                    return 3;
                }
            }
            RenderWorkerRequest::CloseDocument(request) => {
                let response = if handshaken {
                    close_document_response(request)
                } else {
                    DocumentResponse {
                        request_id: request.request_id,
                        owner_id: request.owner_id,
                        ok: false,
                        payload_encoding: None,
                        closed: None,
                        total_ms: 0,
                        error: Some("Worker chưa handshake.".to_string()),
                    }
                };
                if write_frame(
                    &mut writer,
                    RenderWorkerFrameKind::Response,
                    frame.request_id,
                    &RenderWorkerResponse::CloseDocument(response),
                    &[],
                )
                .is_err()
                {
                    return 3;
                }
            }
            RenderWorkerRequest::ReleaseAccurateSessionOwner(request) => {
                let response = if handshaken {
                    release_accurate_session_owner_response(request)
                } else {
                    DocumentResponse {
                        request_id: request.request_id,
                        owner_id: request.session_owner_id,
                        ok: false,
                        payload_encoding: None,
                        closed: None,
                        total_ms: 0,
                        error: Some("Worker chưa handshake.".to_string()),
                    }
                };
                if write_frame(
                    &mut writer,
                    RenderWorkerFrameKind::Response,
                    frame.request_id,
                    &RenderWorkerResponse::ReleaseAccurateSessionOwner(response),
                    &[],
                )
                .is_err()
                {
                    return 3;
                }
            }
            RenderWorkerRequest::Ping { nonce } => {
                if !handshaken
                    || write_frame(
                        &mut writer,
                        RenderWorkerFrameKind::Response,
                        frame.request_id,
                        &RenderWorkerResponse::Pong {
                            nonce,
                            worker_pid: std::process::id(),
                        },
                        &[],
                    )
                    .is_err()
                {
                    return 4;
                }
            }
            RenderWorkerRequest::Render(request) => {
                let logical_request_id = request.request_id.clone();
                let (response, payload) = if handshaken {
                    render_response(request, cancel_token.as_ref())
                } else {
                    (
                        RenderResponse {
                            request_id: request.request_id,
                            owner_id: request.owner_id,
                            generation: request.generation,
                            status: RenderResponseStatus::Error,
                            bitmap_width: None,
                            bitmap_height: None,
                            pipeline_identity: request.pipeline_identity,
                            cache_tier: RenderCacheTier::None,
                            timing: RenderTiming::default(),
                            soundness: request.soundness,
                            unsupported_reason: None,
                            fallback_font_sha256: (request.color.pipeline
                                == RenderColorPipeline::Accurate)
                                .then(|| PPE_FALLBACK_FONT_SHA256.to_string()),
                            substituted_fonts: Vec::new(),
                            geometry_approximated: false,
                            error: Some("Worker chưa handshake.".to_string()),
                        },
                        Vec::new(),
                    )
                };
                active_tokens
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&logical_request_id);
                if write_frame(
                    &mut writer,
                    RenderWorkerFrameKind::Response,
                    frame.request_id,
                    &RenderWorkerResponse::Render(response),
                    &payload,
                )
                .is_err()
                {
                    return 3;
                }
            }
            RenderWorkerRequest::Cancel(_) => {
                unreachable!("lệnh hủy một chiều phải được luồng control giữ lại")
            }
            RenderWorkerRequest::Shutdown => {
                let response = RenderWorkerResponse::Shutdown { ok: true };
                let _ = write_frame(
                    &mut writer,
                    RenderWorkerFrameKind::Response,
                    frame.request_id,
                    &response,
                    &[],
                );
                return 0;
            }
        }
    }
}

struct RenderWorkerClient {
    child: Arc<Mutex<Child>>,
    child_pid: u32,
    stdin: Arc<Mutex<ChildStdin>>,
    responses: Arc<response_router::ResponseRouter>,
    next_request_id: u64,
    lane: WorkerLane,
}

#[derive(Debug)]
enum ClientRequestError {
    Cancelled,
    Transport(String),
}

struct PendingClientResponse {
    response: mpsc::Receiver<response_router::ResponseResult>,
    logical_request_id: Option<String>,
    child_pid: u32,
    wire_request_id: u64,
}

impl PendingClientResponse {
    fn wait(self) -> Result<RenderWorkerFrame<RenderWorkerResponse>, ClientRequestError> {
        self.response.recv()
            .map_err(|error| ClientRequestError::Transport(format!("Reader worker đã dừng: {error}")))?
            .map_err(ClientRequestError::Transport)
    }
}

impl Drop for PendingClientResponse {
    fn drop(&mut self) {
        if let Some(request_id) = &self.logical_request_id {
            unregister_active_render_request(request_id, self.child_pid, self.wire_request_id);
        }
    }
}

impl RenderWorkerClient {
    fn request(
        &mut self,
        request: &RenderWorkerRequest,
        cancellation: Option<&AtomicBool>,
    ) -> Result<RenderWorkerFrame<RenderWorkerResponse>, ClientRequestError> {
        self.begin_request(request, cancellation)?.wait()
    }

    /// Ghi trọn request rồi trả ticket để caller nhả slot trước khi chờ.
    /// Đường tuần tự cũ cũng dùng router này, không có hai reader stdout.
    fn begin_request(
        &mut self,
        request: &RenderWorkerRequest,
        cancellation: Option<&AtomicBool>,
    ) -> Result<PendingClientResponse, ClientRequestError> {
        if let Some(status) = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .try_wait()
            .map_err(|error| {
                ClientRequestError::Transport(format!(
                    "Không đọc được trạng thái display worker: {error}"
                ))
            })?
        {
            return Err(ClientRequestError::Transport(format!(
                "Display worker đã thoát sớm: {status}"
            )));
        }
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.checked_add(1).ok_or_else(||
            ClientRequestError::Transport("Worker đã hết miền wire request ID.".into()))?;
        let cancellable_request = match request {
            RenderWorkerRequest::Render(render) => Some((
                render.request_id.clone(),
                request_purpose(request),
                render.color.pipeline == RenderColorPipeline::Accurate,
            )),
            RenderWorkerRequest::Bootstrap(document) => Some((
                document.request_id.clone(),
                RenderPurpose::Interactive,
                false,
            )),
            RenderWorkerRequest::Metadata(document) => Some((
                document.request_id.clone(),
                RenderPurpose::Background,
                false,
            )),
            _ => None,
        };
        // PERF (audit 2026-08-09 §L4C): request bị hủy khi còn chờ lane tuyệt đối không
        // được gửi vào worker. Sau khi frame đã ghi trọn vẹn mới công bố lease để lệnh
        // cancel một chiều không thể vượt lên trước frame render trên cùng stdin.
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(ClientRequestError::Cancelled);
        }
        // Đăng ký trước write: reply có thể đến ngay sau flush.
        let response = self.responses.register(request_id).map_err(ClientRequestError::Transport)?;
        let write_result = {
            let mut stdin = self
                .stdin
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            write_frame(
                &mut *stdin,
                RenderWorkerFrameKind::Request,
                request_id,
                request,
                &[],
            )
        };
        if let Err(error) = write_result {
            let error = format!("Không gửi được request display worker: {error}");
            self.responses.fail(error.clone());
            return Err(ClientRequestError::Transport(error));
        }
        if let Some((logical_id, purpose, cooperative_cancel)) = cancellable_request.as_ref() {
            register_active_render_request(
                logical_id,
                ActiveRenderLease {
                    child: Arc::clone(&self.child),
                    child_pid: self.child_pid,
                    stdin: Arc::clone(&self.stdin),
                    wire_request_id: request_id,
                    lane: self.lane,
                    purpose: *purpose,
                    cooperative_cancel: *cooperative_cancel,
                },
            );
            // Cancel có thể đến đúng cửa sổ giữa pre-check và lúc công bố lease. Cờ pending
            // giữ lại tín hiệu đó; gửi control ngay sau đăng ký thay vì để request stale chạy hết.
            if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                cancel_active_render_request(logical_id);
            }
        }
        Ok(PendingClientResponse { response,
            logical_request_id: cancellable_request.map(|(id, _, _)| id),
            child_pid: self.child_pid, wire_request_id: request_id })
    }

    fn terminate(&mut self) {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = child.kill();
        let _ = child.wait();
        self.responses.fail("Worker đã được đóng.".into());
    }
}

impl Drop for RenderWorkerClient {
    fn drop(&mut self) { self.terminate(); }
}

#[derive(Clone)]
struct ActiveRenderLease {
    child: Arc<Mutex<Child>>,
    child_pid: u32,
    stdin: Arc<Mutex<ChildStdin>>,
    wire_request_id: u64,
    lane: WorkerLane,
    purpose: RenderPurpose,
    cooperative_cancel: bool,
}

static ACTIVE_RENDER_REQUESTS: OnceLock<Mutex<HashMap<String, ActiveRenderLease>>> =
    OnceLock::new();

fn active_render_requests() -> &'static Mutex<HashMap<String, ActiveRenderLease>> {
    ACTIVE_RENDER_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_active_render_request(request_id: &str, lease: ActiveRenderLease) {
    active_render_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(request_id.to_string(), lease);
}

fn unregister_active_render_request(request_id: &str, child_pid: u32, wire_request_id: u64) {
    let mut active = active_render_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active
        .get(request_id)
        .is_some_and(|lease| lease.child_pid == child_pid && lease.wire_request_id == wire_request_id)
    {
        active.remove(request_id);
    }
}

struct PendingWorkerControl {
    cancelled: AtomicBool,
}

static PENDING_RENDER_REQUESTS: OnceLock<Mutex<HashMap<String, Arc<PendingWorkerControl>>>> =
    OnceLock::new();

fn pending_render_requests() -> &'static Mutex<HashMap<String, Arc<PendingWorkerControl>>> {
    PENDING_RENDER_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) struct PendingWorkerLease {
    request_id: String,
    control: Arc<PendingWorkerControl>,
}

impl PendingWorkerLease {
    pub(crate) fn register(request_id: &str) -> Result<Self, String> {
        let control = Arc::new(PendingWorkerControl {
            cancelled: AtomicBool::new(false),
        });
        let mut pending = pending_render_requests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending.contains_key(request_id) {
            return Err("request_id render đang được sử dụng.".to_string());
        }
        pending.insert(request_id.to_string(), Arc::clone(&control));
        Ok(Self {
            request_id: request_id.to_string(),
            control,
        })
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.control.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for PendingWorkerLease {
    fn drop(&mut self) {
        let mut pending = pending_render_requests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending
            .get(&self.request_id)
            .is_some_and(|control| Arc::ptr_eq(control, &self.control))
        {
            pending.remove(&self.request_id);
        }
    }
}

// PERF (audit 2026-09-23 §R23.SHARED-SESSION): nhường lane có deadline,
// không phải giới hạn worker/DPI. Codec không có checkpoint vẫn có kill fallback.
const PPE_PRIORITY_CANCEL_GRACE: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PriorityPreemptionOutcome { Cooperative, Killed, Failed }

#[derive(Default)]
struct PriorityPreemptionState {
    response_received: bool,
    outcome: Option<PriorityPreemptionOutcome>,
}

struct PriorityPreemptionNotice {
    state: Mutex<PriorityPreemptionState>,
    wake: Condvar,
}

impl PriorityPreemptionNotice {
    fn new() -> Self {
        Self { state: Mutex::new(PriorityPreemptionState::default()), wake: Condvar::new() }
    }

    fn response_received(&self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).response_received = true;
        self.wake.notify_all();
    }

    fn finish(&self, outcome: PriorityPreemptionOutcome) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.outcome.is_none() { state.outcome = Some(outcome); }
        self.wake.notify_all();
    }

    fn wait_for_response(&self, grace: Duration) -> bool {
        let deadline = Instant::now() + grace;
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        while !state.response_received {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return false; }
            state = self.wake.wait_timeout(state, remaining)
                .unwrap_or_else(|p| p.into_inner()).0;
        }
        true
    }

    fn wait_outcome(&self) -> PriorityPreemptionOutcome {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        while state.outcome.is_none() {
            state = self.wake.wait(state).unwrap_or_else(|p| p.into_inner());
        }
        state.outcome.unwrap()
    }
}

struct PriorityPreemptionCompletion(Arc<PriorityPreemptionNotice>);
impl Drop for PriorityPreemptionCompletion {
    fn drop(&mut self) { self.0.finish(PriorityPreemptionOutcome::Failed); }
}

type PriorityPreemptionKey = (u32, u64);
static PRIORITY_PREEMPTIONS: OnceLock<Mutex<HashMap<PriorityPreemptionKey, Arc<PriorityPreemptionNotice>>>> = OnceLock::new();

fn priority_preemptions() -> &'static Mutex<HashMap<PriorityPreemptionKey, Arc<PriorityPreemptionNotice>>> {
    PRIORITY_PREEMPTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_priority_preemption(child_pid: u32, wire_request_id: u64) -> PriorityPreemptionCompletion {
    let notice = Arc::new(PriorityPreemptionNotice::new());
    if let Some(previous) = priority_preemptions().lock().unwrap_or_else(|p| p.into_inner())
        .insert((child_pid, wire_request_id), Arc::clone(&notice))
    {
        previous.finish(PriorityPreemptionOutcome::Failed);
    }
    PriorityPreemptionCompletion(notice)
}

fn take_priority_preemption(child_pid: u32, wire_request_id: u64) -> Option<PriorityPreemptionOutcome> {
    let notice = priority_preemptions().lock().unwrap_or_else(|p| p.into_inner())
        .remove(&(child_pid, wire_request_id));
    notice.map(|notice| {
        // Giữ mutex worker/gate tới khi hành động preempt đã xong. Một Ready tới
        // sát lúc hủy không được nhả lane rồi để kill fallback đánh nhầm request mới.
        notice.response_received();
        notice.wait_outcome()
    })
}

fn priority_retry_for_response(outcome: Option<PriorityPreemptionOutcome>, status: RenderResponseStatus) -> bool {
    matches!(outcome, Some(PriorityPreemptionOutcome::Cooperative | PriorityPreemptionOutcome::Killed))
        && status == RenderResponseStatus::Cancelled
}

fn send_cooperative_cancel(lease: &ActiveRenderLease, request_id: &str) -> bool {
    let cancel = RenderWorkerRequest::Cancel(CancelRequest { request_id: request_id.to_string() });
    let mut stdin = lease.stdin.lock().unwrap_or_else(|p| p.into_inner());
    write_frame(&mut *stdin, RenderWorkerFrameKind::Request, lease.wire_request_id, &cancel, &[]).is_ok()
}

static BACKGROUND_PREEMPTION_COUNT: AtomicUsize = AtomicUsize::new(0);

fn preempt_background_on_lane(target_lane: WorkerLane) -> bool {
    let leases = {
        let mut active = active_render_requests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let request_ids = active
            .iter()
            .filter_map(|(request_id, lease)| {
                (lease.lane == target_lane
                    && lease.purpose != RenderPurpose::Interactive)
                    .then_some(request_id.clone())
            })
            .collect::<Vec<_>>();
        request_ids
            .into_iter()
            .filter_map(|request_id| active.remove(&request_id).map(|lease| {
                // Công bố notice khi còn giữ active registry: unregister của
                // response phải thấy notice, kể cả khi bitmap vừa dựng xong.
                let completion = register_priority_preemption(lease.child_pid, lease.wire_request_id);
                (request_id, lease, completion)
            }))
            .collect::<Vec<_>>()
    };

    let mut preempted_any = false;
    for (request_id, lease, completion) in leases {
        // PDFium/metadata chưa có checkpoint vẫn kill như trước. Cả hai đường
        // dùng notice theo wire ID để reply Ready muộn không nhả slot trước kill.
        let cooperative = lease.cooperative_cancel
            && send_cooperative_cancel(&lease, &request_id)
            && completion.0.wait_for_response(PPE_PRIORITY_CANCEL_GRACE);
        let outcome = if cooperative {
            PriorityPreemptionOutcome::Cooperative
        } else if lease.child.lock().unwrap_or_else(|p| p.into_inner()).kill().is_ok() {
            PriorityPreemptionOutcome::Killed
        } else {
            PriorityPreemptionOutcome::Failed
        };
        completion.0.finish(outcome);
        if outcome != PriorityPreemptionOutcome::Failed {
            preempted_any = true;
            BACKGROUND_PREEMPTION_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        crate::perf_log(&format!(
            "RENDER_WORKER_PREEMPT mode={outcome:?} pid={} request_id={request_id}", lease.child_pid));
    }
    preempted_any
}

#[derive(Default)]
struct SharedLaneState {
    active_purpose: Option<RenderPurpose>,
    interactive_waiters: usize,
}

struct SharedLanePriorityGate {
    lane: WorkerLane,
    state: Mutex<SharedLaneState>,
    wake: Condvar,
}

impl SharedLanePriorityGate {
    fn new(lane: WorkerLane) -> Self {
        Self {
            lane,
            state: Mutex::new(SharedLaneState::default()),
            wake: Condvar::new(),
        }
    }

    fn acquire<'a>(
        &'a self,
        purpose: RenderPurpose,
        cancellation: Option<&AtomicBool>,
    ) -> Result<SharedLanePriorityLease<'a>, String> {
        let normalized = if purpose == RenderPurpose::Interactive {
            RenderPurpose::Interactive
        } else {
            RenderPurpose::Background
        };
        let interactive = normalized == RenderPurpose::Interactive;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if interactive {
            state.interactive_waiters += 1;
        }

        loop {
            if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                if interactive {
                    state.interactive_waiters = state.interactive_waiters.saturating_sub(1);
                    self.wake.notify_all();
                }
                return Err("Render request đã bị hủy trước khi vào worker.".to_string());
            }
            if interactive && state.active_purpose == Some(RenderPurpose::Background) {
                drop(state);
                let preempted = preempt_background_on_lane(self.lane);
                state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                // Background đã lấy gate nhưng có thể chưa kịp đăng ký child lease.
                // Chờ rất ngắn để nó tiến tới điểm đăng ký hoặc tự nhả gate, tránh busy-spin.
                if !preempted && state.active_purpose == Some(RenderPurpose::Background) {
                    let (next, _) = self
                        .wake
                        .wait_timeout(state, std::time::Duration::from_millis(1))
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state = next;
                }
                continue;
            }

            let can_start =
                state.active_purpose.is_none() && (interactive || state.interactive_waiters == 0);
            if can_start {
                if interactive {
                    state.interactive_waiters = state.interactive_waiters.saturating_sub(1);
                }
                state.active_purpose = Some(normalized);
                return Ok(SharedLanePriorityLease { gate: self });
            }

            let (next, _) = self
                .wake
                .wait_timeout(state, std::time::Duration::from_millis(25))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
    }

    fn notify_cancelled(&self) {
        self.wake.notify_all();
    }

    fn is_idle(&self) -> bool {
        self.state.try_lock().is_ok_and(|state|
            state.active_purpose.is_none() && state.interactive_waiters == 0)
    }
}

struct SharedLanePriorityLease<'a> {
    gate: &'a SharedLanePriorityGate,
}

impl Drop for SharedLanePriorityLease<'_> {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active_purpose = None;
        self.gate.wake.notify_all();
    }
}

struct AccurateDocumentAffinity {
    lane: WorkerLane,
    owners: AccurateOwnerLeases,
    in_flight: Arc<AtomicUsize>,
}

struct AccurateRequestLease(Arc<AtomicUsize>);
impl Drop for AccurateRequestLease {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); }
}

struct RenderWorkerManager {
    interactive: Mutex<Option<RenderWorkerClient>>,
    backgrounds: Vec<Mutex<Option<RenderWorkerClient>>>,
    next_background: AtomicUsize,
    /// PERF (audit 2026-09-23 §R23.02): giữ các request nền của cùng một
    /// snapshot PDF trên cùng worker để tái dùng DOC_CACHE/page LRU thay vì
    /// round-robin rồi mở/parse lại tài liệu ở process khác.
    document_affinity: Mutex<HashMap<String, WorkerLane>>,
    accurate_document_affinity: Mutex<HashMap<String, AccurateDocumentAffinity>>,
    shared_lane_gate: SharedLanePriorityGate,
    background_lane_gates: Vec<SharedLanePriorityGate>,
}

impl RenderWorkerManager {
    fn new(background_lane_count: usize) -> Self {
        Self {
            interactive: Mutex::new(None),
            backgrounds: (0..background_lane_count)
                .map(|_| Mutex::new(None))
                .collect(),
            next_background: AtomicUsize::new(0),
            document_affinity: Mutex::new(HashMap::new()),
            accurate_document_affinity: Mutex::new(HashMap::new()),
            shared_lane_gate: SharedLanePriorityGate::new(WorkerLane::Interactive),
            background_lane_gates: (0..background_lane_count)
                .map(|index| SharedLanePriorityGate::new(WorkerLane::Background(index))).collect(),
        }
    }

    fn slot(&self, lane: WorkerLane) -> &Mutex<Option<RenderWorkerClient>> {
        match lane { WorkerLane::Interactive => &self.interactive, WorkerLane::Background(i) => &self.backgrounds[i] }
    }

    fn gate(&self, lane: WorkerLane) -> &SharedLanePriorityGate {
        match lane { WorkerLane::Interactive => &self.shared_lane_gate, WorkerLane::Background(i) => &self.background_lane_gates[i] }
    }

    fn lane_is_idle(&self, lane: WorkerLane) -> bool {
        self.gate(lane).is_idle() && self.slot(lane).try_lock().is_ok()
    }

    fn notify_cancelled(&self) {
        self.shared_lane_gate.notify_cancelled();
        for gate in &self.background_lane_gates { gate.notify_cancelled(); }
    }
}

static RENDER_WORKER_MANAGER: OnceLock<RenderWorkerManager> = OnceLock::new();
static RENDER_WORKER_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn render_worker_manager() -> &'static RenderWorkerManager {
    RENDER_WORKER_MANAGER
        .get_or_init(|| RenderWorkerManager::new(configured_background_lane_count()))
}

fn document_affinity_key(document: &RenderDocumentIdentity) -> String {
    // Path có thể chứa dấu '|', nên dùng NUL làm dấu phân cách nội bộ thay vì
    // ghép chuỗi mơ hồ. Token đã mang size/mtime/ctime của snapshot nguồn.
    format!("{}\u{0}{}", document.path, document.token)
}

fn document_affinity_tag(affinity_key: &str) -> String {
    // Telemetry không ghi path PDF; mã băm ngắn đủ để ghép các phase của cùng
    // một snapshot trong log runtime mà không lộ tên file khách hàng.
    let digest = hex::encode(sha2::Sha256::digest(affinity_key.as_bytes()));
    digest[..12].to_string()
}

fn clear_document_affinity_for_path(
    affinities: &mut HashMap<String, WorkerLane>,
    file_path: &str,
    lane: WorkerLane,
) {
    let prefix = format!("{}\u{0}", file_path);
    affinities.retain(|key, existing| *existing != lane || !key.starts_with(&prefix));
}

fn render_request_document_affinity(request: &RenderWorkerRequest) -> Option<String> {
    match request {
        RenderWorkerRequest::Render(render) => Some(document_affinity_key(&render.document)),
        _ => None,
    }
}

fn reserve_background_affinity<T>(
    affinities: &Mutex<HashMap<String, WorkerLane>>,
    affinity_key: Option<&str>,
    select: impl FnOnce() -> (WorkerLane, Option<T>),
) -> (WorkerLane, bool, Option<T>) {
    // PERF (audit 2026-09-23 §R23.AFFINITY-ATOMIC): giữ lookup → chọn → publish
    // trong một vùng khóa ngắn. select chỉ được try_lock, không spawn/render/chờ
    // worker; nếu không, hai request cold có thể mở cùng PDF ở hai process.
    let mut reserved = affinity_key.map(|_| affinities.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()));
    if let (Some(key), Some(entries)) = (affinity_key, reserved.as_ref()) {
        let existing = entries.get(key).copied();
        if let Some(lane @ WorkerLane::Background(_)) = existing {
            return (lane, true, None);
        }
    }
    let (lane, selected) = select();
    if let (Some(key), Some(entries)) = (affinity_key, reserved.as_mut()) {
        entries.insert(key.to_string(), lane);
    }
    (lane, false, selected)
}

fn reserve_background_lane(
    manager: &RenderWorkerManager,
    affinity_key: Option<&str>,
) -> (usize, bool) {
    let lane_count = manager.backgrounds.len();
    let (lane, hit, _) = reserve_background_affinity::<()>(
        &manager.document_affinity,
        affinity_key,
        || {
            let start = manager.next_background.fetch_add(1, Ordering::Relaxed) % lane_count;
            for offset in 0..lane_count {
                let index = (start + offset) % lane_count;
                if manager.lane_is_idle(WorkerLane::Background(index)) {
                    return (WorkerLane::Background(index), None);
                }
            }
            (WorkerLane::Background(start), None)
        },
    );
    let WorkerLane::Background(index) = lane else { unreachable!("affinity nền"); };
    (index, hit)
}

#[cfg(test)]
fn reserve_background_worker<'a>(manager: &'a RenderWorkerManager, key: Option<&str>)
    -> (usize, bool, WorkerLaneLease<'a>)
{
    let (index, hit) = reserve_background_lane(manager, key);
    let lease = acquire_worker_lane(manager, WorkerLane::Background(index), RenderPurpose::Background, None)
        .expect("test lấy được lane");
    (index, hit, lease)
}

fn reserve_accurate_lane(
    manager: &RenderWorkerManager, key: &str, owner: &str,
    purpose: RenderPurpose, now: Instant,
) -> (WorkerLane, bool) {
    // PERF (audit 2026-09-23 §R23.SHARED-DOC): pipeline PPE dùng một lease theo
    // snapshot, không theo priority. Chỉ chọn lane khi chưa có lease; không chờ
    // mutex worker hoặc I/O trong khóa registry.
    let mut entries = manager.accurate_document_affinity.lock().unwrap_or_else(|p| p.into_inner());
    entries.retain(|_, entry| {
        entry.owners.prune_stale(now, ACCURATE_SESSION_OWNER_TTL);
        !entry.owners.is_empty() || entry.in_flight.load(Ordering::Acquire) > 0
    });
    if let Some(entry) = entries.get_mut(key) {
        entry.owners.bind(owner, now);
        return (entry.lane, true);
    }
    let mut candidates = Vec::with_capacity(manager.backgrounds.len() + 1);
    if purpose == RenderPurpose::Interactive { candidates.push(WorkerLane::Interactive); }
    if !manager.backgrounds.is_empty() {
        let start = manager.next_background.fetch_add(1, Ordering::Relaxed) % manager.backgrounds.len();
        for offset in 0..manager.backgrounds.len() {
            candidates.push(WorkerLane::Background((start + offset) % manager.backgrounds.len()));
        }
    }
    if purpose != RenderPurpose::Interactive { candidates.push(WorkerLane::Interactive); }
    let lane = candidates.into_iter().enumerate().min_by_key(|(rank, lane)| (
        !manager.lane_is_idle(*lane),
        entries.values().filter(|entry| entry.lane == *lane).count(),
        *rank,
    )).expect("manager luôn có lane tương tác").1;
    let mut owners = AccurateOwnerLeases::default();
    owners.bind(owner, now);
    entries.insert(key.to_string(), AccurateDocumentAffinity {
        lane, owners, in_flight: Arc::new(AtomicUsize::new(0)),
    });
    (lane, false)
}

fn pin_accurate_request(
    manager: &RenderWorkerManager, key: &str, owner: &str, lane: WorkerLane,
) -> Option<AccurateRequestLease> {
    let mut entries = manager.accurate_document_affinity.lock().unwrap_or_else(|p| p.into_inner());
    let entry = entries.entry(key.to_string()).or_insert_with(|| AccurateDocumentAffinity {
        lane, owners: AccurateOwnerLeases::default(), in_flight: Arc::new(AtomicUsize::new(0)),
    });
    // Worker có thể đã chết/được close trong lúc chờ gate. Nếu request khác đã
    // chọn lane mới, chọn lại theo registry trước khi gửi bytes, không mở bản thứ hai.
    if entry.lane != lane { return None; }
    entry.owners.bind(owner, Instant::now());
    entry.in_flight.fetch_add(1, Ordering::AcqRel);
    Some(AccurateRequestLease(Arc::clone(&entry.in_flight)))
}

fn retire_worker_affinities(manager: &RenderWorkerManager, lane: WorkerLane) {
    manager.document_affinity.lock().unwrap_or_else(|p| p.into_inner())
        .retain(|_, existing| *existing != lane);
    manager.accurate_document_affinity.lock().unwrap_or_else(|p| p.into_inner())
        .retain(|_, entry| entry.lane != lane);
    crate::perf_log(&format!("RENDER_WORKER_AFFINITY action=retire-worker lane={lane:?}"));
}

fn close_lane_document_affinities(manager: &RenderWorkerManager, lane: WorkerLane, path: &str) {
    // Caller giữ mutex slot sau CloseDocument: không xóa lease của một render
    // đang chạy rồi để request mới mở cùng snapshot ở worker khác.
    let prefix = format!("{path}\u{0}");
    clear_document_affinity_for_path(
        &mut manager.document_affinity.lock().unwrap_or_else(|p| p.into_inner()), path, lane);
    manager.accurate_document_affinity.lock().unwrap_or_else(|p| p.into_inner())
        .retain(|key, entry| entry.lane != lane || !key.starts_with(&prefix));
}

fn release_lane_accurate_owner(manager: &RenderWorkerManager, lane: WorkerLane, owner: &str) {
    manager.accurate_document_affinity.lock().unwrap_or_else(|p| p.into_inner())
        .retain(|_, entry| {
            if entry.lane != lane { return true; }
            entry.owners.release(owner);
            !entry.owners.is_empty() || entry.in_flight.load(Ordering::Acquire) > 0
        });
}

// Thứ tự drop quan trọng: nhả mutex slot trước, rồi mới cho request kế lấy gate.
struct WorkerLaneLease<'a> {
    slot: MutexGuard<'a, Option<RenderWorkerClient>>,
    _priority: SharedLanePriorityLease<'a>,
}

fn acquire_worker_lane<'a>(
    manager: &'a RenderWorkerManager, lane: WorkerLane, purpose: RenderPurpose,
    cancellation: Option<&AtomicBool>,
) -> Result<WorkerLaneLease<'a>, WorkerTransportFailure> {
    let priority = manager.gate(lane).acquire(purpose, cancellation)
        .map_err(|message| WorkerTransportFailure {
            request_started: false, cancelled: true, preempted_background: false, message,
        })?;
    let slot = manager.slot(lane).lock().unwrap_or_else(|p| p.into_inner());
    Ok(WorkerLaneLease { slot, _priority: priority })
}

fn cancel_active_render_request(request_id: &str) -> bool {
    let lease = active_render_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(request_id);
    let Some(lease) = lease else {
        return false;
    };
    if lease.cooperative_cancel {
        // PERF (audit 2026-08-09 §L4C): PPE có checkpoint CancelToken nên chỉ gửi control
        // một chiều. Giữ process sống đồng nghĩa giữ RenderSession, image cache và PageProgram.
        let sent = send_cooperative_cancel(&lease, request_id);
        if sent {
            crate::perf_log(&format!(
                "RENDER_WORKER_CANCEL mode=cooperative pid={} request_id={}",
                lease.child_pid, request_id
            ));
            return true;
        }
        log::warn!(
            "[RENDER_WORKER] Không gửi được cooperative cancel cho {}; kill fallback worker {}",
            request_id,
            lease.child_pid
        );
    }
    let _ = lease
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .kill();
    true
}

pub fn cancel_render_request(request_id: &str) -> bool {
    let pending = pending_render_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(request_id)
        .cloned();
    if let Some(control) = pending.as_ref() {
        control.cancelled.store(true, Ordering::Release);
    }
    let had_active = cancel_active_render_request(request_id);
    if let Some(manager) = RENDER_WORKER_MANAGER.get() {
        manager.notify_cancelled();
    }
    pending.is_some() || had_active
}

fn spawn_render_worker_client(lane: WorkerLane) -> Result<RenderWorkerClient, String> {
    let expected_pdfium_hash = expected_pdfium_sha256()?;
    #[cfg(test)]
    let executable = std::env::var_os("PRYNX_RENDER_WORKER_TEST_EXE")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_exe)
        .map_err(|error| format!("Không tìm được executable cho display worker: {error}"))?;
    #[cfg(not(test))]
    let executable = std::env::current_exe()
        .map_err(|error| format!("Không tìm được executable cho display worker: {error}"))?;
    let mut command = std::process::Command::new(executable);
    command
        .arg("--prynx-render-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let spawn_started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Không spawn được display worker: {error}"))?;
    let child_pid = child.id();
    // SEC (audit 2026-09-04 §SEC.22): gán Job ngay sau spawn, trước khi đọc
    // pipe hoặc khởi tạo thread. Chạy worker ngoài Job sẽ giữ file cài đặt sau
    // crash, nên phải hủy tiến trình và fail-closed khi kernel từ chối gán.
    if let Err(error) = crate::process_guard::adopt_child_process(child_pid) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "Không bảo vệ được display worker bằng Job Object: {error}"
        ));
    }
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Display worker thiếu stdin pipe.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Display worker thiếu stdout pipe.".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        let _ = std::thread::Builder::new()
            .name("prynx-render-worker-stderr".to_string())
            .spawn(move || {
                for line in std::io::BufReader::new(stderr)
                    .lines()
                    .map_while(Result::ok)
                {
                    log::warn!("[RENDER_WORKER] {}", line);
                }
            });
    }
    let nonce = format!(
        "{}-{}-{:016x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0),
        rand::random::<u64>(),
    );
    let hello_request_id = format!("hello-{}-{child_pid}", std::process::id());
    let mut client = RenderWorkerClient {
        child: Arc::new(Mutex::new(child)),
        child_pid,
        stdin: Arc::new(Mutex::new(stdin)),
        responses: Arc::new(response_router::ResponseRouter::default()),
        next_request_id: 1,
        lane,
    };
    let responses = Arc::clone(&client.responses);
    std::thread::Builder::new().name("prynx-render-worker-responses".into())
        .spawn(move || responses.read_responses(stdout))
        .map_err(|error| format!("Không khởi tạo được reader response worker: {error}"))?;
    let frame = client
        .request(
            &RenderWorkerRequest::Hello(HelloRequest {
                request_id: hello_request_id.clone(),
                parent_pid: std::process::id(),
                nonce: nonce.clone(),
                expected_app_version: env!("CARGO_PKG_VERSION").to_string(),
                expected_tile_cache_version: crate::TILE_RENDER_CACHE_VERSION.to_string(),
                expected_pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
            }),
            None,
        )
        .map_err(|error| match error {
            ClientRequestError::Cancelled => "Handshake display worker bị hủy.".to_string(),
            ClientRequestError::Transport(message) => message,
        })?;
    let RenderWorkerResponse::Hello(response) = frame.header else {
        client.terminate();
        return Err("Display worker không trả Hello response.".to_string());
    };
    let identity_matches = response.ok
        && response.request_id == hello_request_id
        && response.nonce == nonce
        && response.worker_pid == child_pid
        && response.protocol_version == RENDER_WORKER_PROTOCOL_VERSION
        && response.app_version == env!("CARGO_PKG_VERSION")
        && response.tile_cache_version == crate::TILE_RENDER_CACHE_VERSION
        && response.pipeline_identity == RENDER_WORKER_DISPLAY_PIPELINE_ID
        && expected_pdfium_hash
            .as_ref()
            .is_none_or(|expected| response.pdfium_sha256.as_ref() == Some(expected));
    if !identity_matches {
        let error = response
            .error
            .unwrap_or_else(|| "Handshake display worker không khớp identity.".to_string());
        client.terminate();
        return Err(error);
    }
    crate::perf_log(&format!(
        "RENDER_WORKER_SPAWN pid={} handshake_ms={}",
        child_pid,
        spawn_started.elapsed().as_millis()
    ));
    Ok(client)
}

#[derive(Debug)]
struct WorkerTransportFailure {
    request_started: bool,
    cancelled: bool,
    preempted_background: bool,
    message: String,
}

fn request_purpose(request: &RenderWorkerRequest) -> RenderPurpose {
    match request {
        RenderWorkerRequest::Metadata(_) => RenderPurpose::Background,
        RenderWorkerRequest::Render(render) => render_lane_purpose(render.purpose, render.priority),
        _ => RenderPurpose::Interactive,
    }
}

pub(crate) fn render_lane_purpose(purpose: RenderPurpose, priority: i32) -> RenderPurpose {
    if purpose == RenderPurpose::Accurate {
        // PERF (audit 2026-08-09 §L3B): `accurate` mô tả pipeline, không phải
        // độ ưu tiên. Frame active priority <100 lấy lane tương tác; nền/prefetch
        // priority >=100 đi lane nền.
        if priority < 100 {
            RenderPurpose::Interactive
        } else {
            RenderPurpose::Background
        }
    } else {
        purpose
    }
}

fn cancelled_transport_failure() -> WorkerTransportFailure {
    WorkerTransportFailure {
        request_started: false,
        cancelled: true,
        preempted_background: false,
        message: "Render request đã bị hủy.".to_string(),
    }
}

fn dispatch_locked_worker(
    slot: &mut Option<RenderWorkerClient>,
    lane: WorkerLane,
    request: &RenderWorkerRequest,
    cancellation: Option<&AtomicBool>,
) -> Result<RenderWorkerFrame<RenderWorkerResponse>, WorkerTransportFailure> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(cancelled_transport_failure());
    }
    if slot.is_none() {
        *slot =
            Some(
                spawn_render_worker_client(lane).map_err(|message| WorkerTransportFailure {
                    request_started: false,
                    cancelled: false,
                    preempted_background: false,
                    message,
                })?,
            );
    }
    let child_pid = slot.as_ref().expect("worker vừa được khởi tạo").child_pid;
    let wire_request_id = slot.as_ref().expect("worker vừa được khởi tạo").next_request_id;
    let result = slot
        .as_mut()
        .expect("worker vừa được khởi tạo")
        .request(request, cancellation);
    let priority_preemption = take_priority_preemption(child_pid, wire_request_id);
    if priority_preemption == Some(PriorityPreemptionOutcome::Killed) {
        // Reply Ready có thể tới sát deadline; PID đã bị kill thì vẫn phải nhả
        // slot trước request kế tiếp, nhưng bitmap Ready hợp lệ không cần render lại.
        if let Some(mut client) = slot.take() { client.terminate(); }
    }
    match result {
        Ok(response) => {
            if matches!(&response.header, RenderWorkerResponse::Render(render)
                if priority_retry_for_response(priority_preemption, render.status))
            {
                return Err(WorkerTransportFailure {
                    request_started: true, cancelled: false, preempted_background: true,
                    message: "PPE nền nhường lane; chờ interactive rồi thử lại cùng session.".into(),
                });
            }
            Ok(response)
        }
        Err(ClientRequestError::Cancelled) => Err(cancelled_transport_failure()),
        Err(ClientRequestError::Transport(message)) => {
            let preempted_background = matches!(priority_preemption,
                    Some(PriorityPreemptionOutcome::Cooperative | PriorityPreemptionOutcome::Killed));
            if let Some(mut client) = slot.take() {
                client.terminate();
            }
            Err(WorkerTransportFailure {
                request_started: true,
                cancelled: false,
                preempted_background,
                message,
            })
        }
    }
}

fn dispatch_worker_request(
    request: &RenderWorkerRequest,
    cancellation: Option<&AtomicBool>,
) -> Result<RenderWorkerFrame<RenderWorkerResponse>, WorkerTransportFailure> {
    let manager = render_worker_manager();
    let purpose = request_purpose(request);
    let affinity_key = render_request_document_affinity(request);
    let accurate_owner = match request {
        RenderWorkerRequest::Render(render) if render.color.pipeline == RenderColorPipeline::Accurate
            && serial_document_affinity_enabled() =>
            Some(render.session_owner_id.as_deref().unwrap_or(&render.owner_id)),
        _ => None,
    };
    loop {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(cancelled_transport_failure());
        }
        let lane = if let Some(owner) = accurate_owner {
            let key = affinity_key.as_deref().expect("Render có document identity");
            let (lane, hit) = reserve_accurate_lane(manager, key, owner, purpose, Instant::now());
            crate::perf_log(&format!(
                "PPE_DOCUMENT_AFFINITY action={} lane={lane:?} document={}",
                if hit { "hit" } else { "assign" }, document_affinity_tag(key)));
            lane
        } else if purpose != RenderPurpose::Interactive && !manager.backgrounds.is_empty() {
            let (index, hit) = reserve_background_lane(manager, affinity_key.as_deref());
            if let Some(key) = affinity_key.as_deref() {
                crate::perf_log(&format!(
                    "RENDER_WORKER_AFFINITY action={} lane=background:{} document={}",
                    if hit { "hit" } else { "assign" }, index, document_affinity_tag(key)));
            }
            WorkerLane::Background(index)
        } else {
            WorkerLane::Interactive
        };
        // Mọi consumer của lane đi qua cùng gate: PPE foreground có thể nhường
        // đúng job nền trên lane affined, không phải chỉ worker Interactive cố định.
        let mut lease = acquire_worker_lane(manager, lane, purpose, cancellation)?;
        let _flight = if let Some(owner) = accurate_owner {
            let Some(flight) = pin_accurate_request(
                manager, affinity_key.as_deref().unwrap(), owner, lane,
            ) else {
                continue;
            };
            Some(flight)
        } else { None };
        let result = dispatch_locked_worker(&mut lease.slot, lane, request, cancellation);
        if lease.slot.is_none() { retire_worker_affinities(manager, lane); }
        return result;
    }
}

pub enum WorkerAttempt<T> {
    Disabled,
    FallbackBeforeStart(String),
    Completed(T),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerUnsupported {
    pub reason: RenderUnsupportedReason,
    pub detail: String,
    pub fallback_font_sha256: Option<String>,
    pub timing: RenderTiming,
}

pub enum AccurateWorkerAttempt {
    Disabled,
    FallbackBeforeStart(String),
    Unsupported(WorkerUnsupported),
    Completed(WorkerRenderOutput),
}

fn dispatch_with_policy(
    request: &RenderWorkerRequest,
    cancellation: Option<&AtomicBool>,
) -> Result<WorkerAttempt<RenderWorkerFrame<RenderWorkerResponse>>, String> {
    let mode = render_worker_mode();
    if mode == RenderWorkerMode::Off {
        return Ok(WorkerAttempt::Disabled);
    }
    if RENDER_WORKER_SHUTTING_DOWN.load(Ordering::Acquire) {
        return Err("Render worker đang dừng cùng ứng dụng.".to_string());
    }
    loop {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err("Render request đã bị hủy.".to_string());
        }
        match dispatch_worker_request(request, cancellation) {
            Ok(frame) => return Ok(WorkerAttempt::Completed(frame)),
            Err(failure) if failure.cancelled => return Err(failure.message),
            Err(failure) if failure.preempted_background => {
                crate::perf_log("RENDER_WORKER_PREEMPT background_retry=1");
                continue;
            }
            Err(failure) if !failure.request_started && mode == RenderWorkerMode::Auto => {
                return Ok(WorkerAttempt::FallbackBeforeStart(failure.message));
            }
            Err(failure) => return Err(failure.message),
        }
    }
}

fn native_request_id(prefix: &str) -> String {
    static REQUEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);
    format!(
        "{}-{}-{}-{}",
        prefix,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed),
    )
}

fn decode_document_payload(
    frame: RenderWorkerFrame<RenderWorkerResponse>,
    expected_request_id: &str,
    expected_owner_id: &str,
    operation: &str,
) -> Result<serde_json::Value, String> {
    let response = match frame.header {
        RenderWorkerResponse::Bootstrap(response) if operation == "bootstrap" => response,
        RenderWorkerResponse::Metadata(response) if operation == "metadata" => response,
        _ => return Err(format!("Display worker trả sai response {operation}.")),
    };
    if response.request_id != expected_request_id || response.owner_id != expected_owner_id {
        return Err(format!("Display worker trả sai identity {operation}."));
    }
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| format!("Display worker {operation} thất bại.")));
    }
    if response.payload_encoding.as_deref() != Some("json-utf8") || frame.payload.is_empty() {
        return Err(format!("Display worker thiếu payload JSON {operation}."));
    }
    serde_json::from_slice(&frame.payload)
        .map_err(|error| format!("Payload JSON {operation} của worker hỏng: {error}"))
}

pub fn bootstrap_with_policy(file_path: &str) -> Result<WorkerAttempt<serde_json::Value>, String> {
    let request_id = native_request_id("bootstrap");
    let owner_id = "tauri:viewer-metadata".to_string();
    let request = RenderWorkerRequest::Bootstrap(DocumentRequest {
        request_id: request_id.clone(),
        owner_id: owner_id.clone(),
        file_path: file_path.to_string(),
    });
    let pending = PendingWorkerLease::register(&request_id)?;
    match dispatch_with_policy(&request, Some(&pending.control.cancelled))? {
        WorkerAttempt::Disabled => Ok(WorkerAttempt::Disabled),
        WorkerAttempt::FallbackBeforeStart(reason) => {
            Ok(WorkerAttempt::FallbackBeforeStart(reason))
        }
        WorkerAttempt::Completed(frame) => {
            decode_document_payload(frame, &request_id, &owner_id, "bootstrap")
                .map(WorkerAttempt::Completed)
        }
    }
}

pub fn metadata_with_policy(
    file_path: &str,
    expected_identity: &str,
) -> Result<WorkerAttempt<serde_json::Value>, String> {
    let request_id = native_request_id("metadata");
    let owner_id = "tauri:viewer-metadata".to_string();
    let request = RenderWorkerRequest::Metadata(MetadataRequest {
        request_id: request_id.clone(),
        owner_id: owner_id.clone(),
        file_path: file_path.to_string(),
        expected_identity: expected_identity.to_string(),
    });
    let pending = PendingWorkerLease::register(&request_id)?;
    match dispatch_with_policy(&request, Some(&pending.control.cancelled))? {
        WorkerAttempt::Disabled => Ok(WorkerAttempt::Disabled),
        WorkerAttempt::FallbackBeforeStart(reason) => {
            Ok(WorkerAttempt::FallbackBeforeStart(reason))
        }
        WorkerAttempt::Completed(frame) => {
            decode_document_payload(frame, &request_id, &owner_id, "metadata")
                .map(WorkerAttempt::Completed)
        }
    }
}

pub fn close_document_with_policy(file_path: &str) -> Result<WorkerAttempt<bool>, String> {
    let mode = render_worker_mode();
    if mode == RenderWorkerMode::Off {
        return Ok(WorkerAttempt::Disabled);
    }
    let request_id = native_request_id("close");
    let owner_id = "tauri:viewer-metadata".to_string();
    let request = RenderWorkerRequest::CloseDocument(DocumentRequest {
        request_id: request_id.clone(),
        owner_id: owner_id.clone(),
        file_path: file_path.to_string(),
    });

    // PERF (audit 2026-08-08 §RENDER.2): mỗi process giữ DOC_CACHE riêng, nên close phải
    // broadcast tới mọi lane đã spawn. Không spawn lane mới chỉ để đóng một cache rỗng.
    let mut closed = if mode == RenderWorkerMode::Auto {
        crate::close_pdf_document_in_process(file_path)?
    } else {
        false
    };
    let Some(manager) = RENDER_WORKER_MANAGER.get() else {
        return Ok(WorkerAttempt::Completed(closed));
    };
    let mut first_error: Option<String> = None;
    let mut close_slot = |lane: WorkerLane| {
        let mut guard = manager.slot(lane).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(client) = guard.as_mut() else {
            close_lane_document_affinities(manager, lane, file_path);
            return;
        };
        match client.request(&request, None) {
            Ok(frame) => {
                let result = match frame.header {
                    RenderWorkerResponse::CloseDocument(response)
                        if response.request_id == request_id && response.owner_id == owner_id =>
                    {
                        if response.ok {
                            Ok(response.closed.unwrap_or(false))
                        } else {
                            Err(response.error.unwrap_or_else(|| {
                                "Display worker close document thất bại.".to_string()
                            }))
                        }
                    }
                    _ => {
                        Err("Display worker trả sai identity/response close document.".to_string())
                    }
                };
                match result {
                    Ok(value) => closed |= value,
                    Err(error) if first_error.is_none() => first_error = Some(error),
                    Err(_) => {}
                }
            }
            Err(ClientRequestError::Cancelled) => {
                if first_error.is_none() {
                    first_error = Some("CloseDocument bị hủy ngoài dự kiến.".to_string());
                }
            }
            Err(ClientRequestError::Transport(error)) => {
                if let Some(mut failed) = guard.take() {
                    failed.terminate();
                }
                retire_worker_affinities(manager, lane);
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        close_lane_document_affinities(manager, lane, file_path);
    };
    close_slot(WorkerLane::Interactive);
    for index in 0..manager.backgrounds.len() {
        close_slot(WorkerLane::Background(index));
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(WorkerAttempt::Completed(closed))
}

pub fn release_accurate_session_owner_with_policy(
    session_owner_id: &str,
) -> Result<WorkerAttempt<bool>, String> {
    valid_identifier(session_owner_id, "session_owner_id")?;
    if render_worker_mode() == RenderWorkerMode::Off {
        return Ok(WorkerAttempt::Disabled);
    }
    let Some(manager) = RENDER_WORKER_MANAGER.get() else {
        return Ok(WorkerAttempt::Completed(false));
    };
    let request_id = native_request_id("ppe-release-owner");
    let request = RenderWorkerRequest::ReleaseAccurateSessionOwner(AccurateSessionOwnerRequest {
        request_id: request_id.clone(),
        session_owner_id: session_owner_id.to_string(),
    });
    let mut released = false;
    let mut first_error: Option<String> = None;
    let mut release_slot = |lane: WorkerLane| {
        let mut guard = manager.slot(lane).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(client) = guard.as_mut() else {
            release_lane_accurate_owner(manager, lane, session_owner_id);
            return;
        };
        match client.request(&request, None) {
            Ok(frame) => match frame.header {
                RenderWorkerResponse::ReleaseAccurateSessionOwner(response)
                    if response.request_id == request_id
                        && response.owner_id == session_owner_id =>
                {
                    if response.ok {
                        released |= response.closed.unwrap_or(false);
                    } else if first_error.is_none() {
                        first_error = Some(response.error.unwrap_or_else(|| {
                            "PPE worker không nhả được session owner.".to_string()
                        }));
                    }
                }
                _ if first_error.is_none() => {
                    first_error = Some(
                        "PPE worker trả sai identity/response khi nhả session owner.".to_string(),
                    );
                }
                _ => {}
            },
            Err(ClientRequestError::Cancelled) => {
                if first_error.is_none() {
                    first_error = Some("Cleanup PPE session bị hủy ngoài dự kiến.".to_string());
                }
            }
            Err(ClientRequestError::Transport(_)) => {
                // Process chết đồng nghĩa mọi RenderSession trong process đã được OS thu.
                if let Some(mut failed) = guard.take() {
                    failed.terminate();
                }
                retire_worker_affinities(manager, lane);
                released = true;
            }
        }
        release_lane_accurate_owner(manager, lane, session_owner_id);
    };
    release_slot(WorkerLane::Interactive);
    for index in 0..manager.backgrounds.len() {
        release_slot(WorkerLane::Background(index));
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(WorkerAttempt::Completed(released))
}

pub fn warm_worker_with_policy() -> Result<WorkerAttempt<()>, String> {
    let nonce = native_request_id("ping");
    let request = RenderWorkerRequest::Ping {
        nonce: nonce.clone(),
    };
    match dispatch_with_policy(&request, None)? {
        WorkerAttempt::Disabled => Ok(WorkerAttempt::Disabled),
        WorkerAttempt::FallbackBeforeStart(reason) => {
            Ok(WorkerAttempt::FallbackBeforeStart(reason))
        }
        WorkerAttempt::Completed(frame) => match frame.header {
            RenderWorkerResponse::Pong { nonce: echoed, .. } if echoed == nonce => {
                Ok(WorkerAttempt::Completed(()))
            }
            _ => Err("Display worker trả sai Pong response.".to_string()),
        },
    }
}

pub struct WorkerRenderOutput {
    pub bytes: Vec<u8>,
    pub response: RenderResponse,
}

#[allow(clippy::too_many_arguments)]
fn render_display_with_policy_inner(
    file_path: &str,
    page: i32,
    zoom: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    context: Option<&ViewerRenderContext>,
    reserved_pending: Option<&PendingWorkerLease>,
) -> Result<WorkerAttempt<WorkerRenderOutput>, String> {
    if render_worker_mode() == RenderWorkerMode::Off {
        return Ok(WorkerAttempt::Disabled);
    }
    let clip = match (clip_x, clip_y, clip_w, clip_h) {
        (None, None, None, None) => None,
        (Some(x), Some(y), Some(width), Some(height)) => Some(RenderClip {
            x,
            y,
            width,
            height,
        }),
        _ => return Err("Clip render phải truyền đủ x/y/width/height.".to_string()),
    };
    let identity = crate::pdf_file_identity(file_path)?;
    let request_id = context
        .map(|value| value.request_id.clone())
        .unwrap_or_else(|| native_request_id("render"));
    let owner_id = context
        .map(|value| value.owner_id.clone())
        .unwrap_or_else(|| "tauri:display".to_string());
    let group_key = context
        .map(|value| value.group_key.clone())
        .unwrap_or_else(|| {
            format!(
                "page:{page}:{}",
                if clip.is_some() { "viewport" } else { "page" }
            )
        });
    let generation = context.map(|value| value.generation).unwrap_or(0);
    let purpose = context
        .map(|value| value.purpose)
        .unwrap_or(RenderPurpose::Interactive);
    let priority = context.map(|value| value.priority).unwrap_or(0);
    let pipeline_identity = context
        .map(|value| value.pipeline_identity.clone())
        .unwrap_or_else(|| RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string());
    if pipeline_identity != RENDER_WORKER_DISPLAY_PIPELINE_ID {
        return Err("Render context không khớp display pipeline.".to_string());
    }
    let request = RenderRequest {
        request_id: request_id.clone(),
        owner_id,
        session_owner_id: None,
        group_key,
        generation,
        purpose,
        priority,
        document: RenderDocumentIdentity {
            path: file_path.to_string(),
            size_bytes: identity.size.to_string(),
            modified_nanos: identity.modified_nanos.to_string(),
            created_nanos: identity.created_nanos.unwrap_or(0).to_string(),
            token: crate::pdf_file_identity_token(identity),
        },
        page,
        rotation,
        raster: RenderRaster::Scale { scale: zoom, clip },
        color: RenderColor {
            pipeline: RenderColorPipeline::Display,
            profile_id: None,
            intent: None,
        },
        pipeline_identity,
        soundness: RenderSoundness::DisplayPreview,
    };
    let owned_pending = if reserved_pending.is_none() {
        Some(PendingWorkerLease::register(&request_id)?)
    } else {
        None
    };
    let pending = reserved_pending
        .or(owned_pending.as_ref())
        .expect("pending render lease phải tồn tại");
    if pending.request_id != request_id {
        return Err("Pending render lease không khớp request_id.".to_string());
    }
    if pending.is_cancelled() {
        return Err("Render request đã bị hủy trước khi vào worker.".to_string());
    }
    let frame = match dispatch_with_policy(
        &RenderWorkerRequest::Render(request),
        Some(&pending.control.cancelled),
    )? {
        WorkerAttempt::Disabled => return Ok(WorkerAttempt::Disabled),
        WorkerAttempt::FallbackBeforeStart(reason) => {
            return Ok(WorkerAttempt::FallbackBeforeStart(reason));
        }
        WorkerAttempt::Completed(frame) => frame,
    };
    if pending.is_cancelled() {
        return Err("Render request đã bị hủy.".to_string());
    }
    let RenderWorkerResponse::Render(response) = frame.header else {
        return Err("Display worker không trả Render response.".to_string());
    };
    if response.request_id != request_id
        || response.pipeline_identity != RENDER_WORKER_DISPLAY_PIPELINE_ID
        || response.generation != generation
    {
        return Err("Display worker trả response không khớp request.".to_string());
    }
    if response.status != RenderResponseStatus::Ready {
        return Err(response
            .error
            .unwrap_or_else(|| "Display worker render thất bại.".to_string()));
    }
    let (width, height) = png_dimensions(&frame.payload);
    if frame.payload.is_empty()
        || width != response.bitmap_width
        || height != response.bitmap_height
    {
        return Err("Display worker trả payload PNG không khớp header.".to_string());
    }
    Ok(WorkerAttempt::Completed(WorkerRenderOutput {
        bytes: frame.payload,
        response,
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn render_display_with_policy(
    file_path: &str,
    page: i32,
    zoom: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    context: Option<&ViewerRenderContext>,
) -> Result<WorkerAttempt<WorkerRenderOutput>, String> {
    render_display_with_policy_inner(
        file_path, page, zoom, rotation, clip_x, clip_y, clip_w, clip_h, context, None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn render_display_with_reserved_policy(
    file_path: &str,
    page: i32,
    zoom: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    context: Option<&ViewerRenderContext>,
    pending: &PendingWorkerLease,
) -> Result<WorkerAttempt<WorkerRenderOutput>, String> {
    render_display_with_policy_inner(
        file_path,
        page,
        zoom,
        rotation,
        clip_x,
        clip_y,
        clip_w,
        clip_h,
        context,
        Some(pending),
    )
}

#[allow(clippy::too_many_arguments)]
fn render_accurate_with_policy_inner(
    file_path: &str,
    page: i32,
    dpi: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    session_owner_id: &str,
    context: Option<&ViewerRenderContext>,
    reserved_pending: Option<&PendingWorkerLease>,
) -> Result<AccurateWorkerAttempt, String> {
    if render_worker_mode() == RenderWorkerMode::Off {
        return Ok(AccurateWorkerAttempt::Disabled);
    }
    let clip = match (clip_x, clip_y, clip_w, clip_h) {
        (None, None, None, None) => None,
        (Some(x), Some(y), Some(width), Some(height)) => Some(RenderClip {
            x,
            y,
            width,
            height,
        }),
        _ => return Err("Clip PPE phải truyền đủ x/y/width/height.".to_string()),
    };
    let identity = crate::pdf_file_identity(file_path)?;
    let request_id = context
        .map(|value| value.request_id.clone())
        .unwrap_or_else(|| native_request_id("ppe-render"));
    let owner_id = context
        .map(|value| value.owner_id.clone())
        .unwrap_or_else(|| "tauri:ppe-accurate".to_string());
    let group_key = context
        .map(|value| value.group_key.clone())
        .unwrap_or_else(|| {
            format!(
                "page:{page}:{}",
                if clip.is_some() { "viewport" } else { "page" }
            )
        });
    let generation = context.map(|value| value.generation).unwrap_or(0);
    let purpose = context
        .map(|value| value.purpose)
        .unwrap_or(RenderPurpose::Interactive);
    let priority = context.map(|value| value.priority).unwrap_or(0);
    let pipeline_identity = context
        .map(|value| value.pipeline_identity.clone())
        .unwrap_or_else(|| RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string());
    if pipeline_identity != RENDER_WORKER_ACCURATE_PIPELINE_ID {
        return Err("Render context không khớp PPE accurate pipeline.".to_string());
    }
    let request = RenderRequest {
        request_id: request_id.clone(),
        owner_id,
        session_owner_id: Some(session_owner_id.to_string()),
        group_key,
        generation,
        purpose,
        priority,
        document: RenderDocumentIdentity {
            path: file_path.to_string(),
            size_bytes: identity.size.to_string(),
            modified_nanos: identity.modified_nanos.to_string(),
            created_nanos: identity.created_nanos.unwrap_or(0).to_string(),
            token: crate::pdf_file_identity_token(identity),
        },
        page,
        rotation,
        raster: RenderRaster::Dpi { dpi, clip },
        color: RenderColor {
            pipeline: RenderColorPipeline::Accurate,
            profile_id: Some(PPE_WORKER_PROFILE_ID.to_string()),
            intent: Some(PPE_WORKER_INTENT.to_string()),
        },
        pipeline_identity,
        soundness: RenderSoundness::ColorVerified,
    };
    let owned_pending = if reserved_pending.is_none() {
        Some(PendingWorkerLease::register(&request_id)?)
    } else {
        None
    };
    let pending = reserved_pending
        .or(owned_pending.as_ref())
        .expect("pending PPE lease phải tồn tại");
    if pending.request_id != request_id {
        return Err("Pending PPE lease không khớp request_id.".to_string());
    }
    if pending.is_cancelled() {
        return Err("PPE request đã bị hủy trước khi vào worker.".to_string());
    }
    let frame = match dispatch_with_policy(
        &RenderWorkerRequest::Render(request),
        Some(&pending.control.cancelled),
    )? {
        WorkerAttempt::Disabled => return Ok(AccurateWorkerAttempt::Disabled),
        WorkerAttempt::FallbackBeforeStart(reason) => {
            return Ok(AccurateWorkerAttempt::FallbackBeforeStart(reason));
        }
        WorkerAttempt::Completed(frame) => frame,
    };
    if pending.is_cancelled() {
        return Err("PPE request đã bị hủy.".to_string());
    }
    let RenderWorkerResponse::Render(response) = frame.header else {
        return Err("PPE worker không trả Render response.".to_string());
    };
    if response.request_id != request_id
        || response.pipeline_identity != RENDER_WORKER_ACCURATE_PIPELINE_ID
        || response.generation != generation
        || response.soundness != RenderSoundness::ColorVerified
    {
        return Err("PPE worker trả response không khớp request.".to_string());
    }
    if response.status == RenderResponseStatus::Unsupported {
        if !frame.payload.is_empty() {
            return Err("PPE worker trả payload cho trạng thái unsupported.".to_string());
        }
        let reason = response
            .unsupported_reason
            .ok_or_else(|| "PPE worker thiếu mã lý do unsupported.".to_string())?;
        return Ok(AccurateWorkerAttempt::Unsupported(WorkerUnsupported {
            reason,
            detail: response
                .error
                .unwrap_or_else(|| "PPE chưa hỗ trợ capability của trang.".to_string()),
            fallback_font_sha256: response.fallback_font_sha256,
            timing: response.timing,
        }));
    }
    if response.status != RenderResponseStatus::Ready {
        return Err(response
            .error
            .unwrap_or_else(|| "PPE worker render thất bại.".to_string()));
    }
    let (width, height) = png_dimensions(&frame.payload);
    if frame.payload.is_empty()
        || width != response.bitmap_width
        || height != response.bitmap_height
    {
        return Err("PPE worker trả payload PNG không khớp header.".to_string());
    }
    Ok(AccurateWorkerAttempt::Completed(WorkerRenderOutput {
        bytes: frame.payload,
        response,
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn render_accurate_with_policy(
    file_path: &str,
    page: i32,
    dpi: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    session_owner_id: &str,
    context: Option<&ViewerRenderContext>,
) -> Result<AccurateWorkerAttempt, String> {
    render_accurate_with_policy_inner(
        file_path,
        page,
        dpi,
        rotation,
        clip_x,
        clip_y,
        clip_w,
        clip_h,
        session_owner_id,
        context,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn render_accurate_with_reserved_policy(
    file_path: &str,
    page: i32,
    dpi: f32,
    rotation: i32,
    clip_x: Option<i32>,
    clip_y: Option<i32>,
    clip_w: Option<i32>,
    clip_h: Option<i32>,
    session_owner_id: &str,
    context: &ViewerRenderContext,
    pending: &PendingWorkerLease,
) -> Result<AccurateWorkerAttempt, String> {
    render_accurate_with_policy_inner(
        file_path,
        page,
        dpi,
        rotation,
        clip_x,
        clip_y,
        clip_w,
        clip_h,
        session_owner_id,
        Some(context),
        Some(pending),
    )
}

/// [PROC-LIFECYCLE FIX 2026-08-28 §UP.4] Trần thời gian cho một lượt dọn display worker.
/// Đủ để worker rảnh trả lời `Shutdown` và tự thoát; hết trần thì diệt cứng.
const RENDER_WORKER_SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);

/// Diệt worker theo PID — KHÔNG đi qua `Mutex<Child>`.
///
/// Vì sao cần: luồng dọn có thể đang giữ lock `Child` (trong `try_wait`/`terminate`) đúng
/// lúc ta hết trần chờ. Nếu đường diệt cứng cũng phải lock `Child` thì nó chặn ở đó và ta
/// mất luôn tác dụng của deadline — đúng kiểu treo mà §UP.4 nói tới.
fn kill_render_worker_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let taskkill = match crate::process_guard::system_taskkill_path() {
            Ok(path) => path,
            Err(error) => {
                log::error!(
                    "[RENDER_WORKER] Không tìm được taskkill.exe hệ thống cho PID={pid}: {error}"
                );
                return;
            }
        };
        let _ = std::process::Command::new(taskkill)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
    }
}

/// Chờ tiến trình con thoát nhưng KHÔNG giữ lock `Child` suốt thời gian chờ.
/// `Child::wait()` giữ lock đến khi tiến trình chết — worker kẹt trong PDFium thì lock đó
/// không bao giờ nhả. Poll `try_wait` và nhả lock giữa các nhịp để đường diệt cứng chen được.
fn wait_child_bounded(child: &Arc<Mutex<Child>>, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let mut guard = child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match guard.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {}
                Err(_) => return,
            }
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub fn shutdown_render_worker() {
    RENDER_WORKER_SHUTTING_DOWN.store(true, Ordering::Release);
    for control in pending_render_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
    {
        control.cancelled.store(true, Ordering::Release);
    }
    let active = active_render_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .drain()
        .map(|(_, lease)| lease)
        .collect::<Vec<_>>();
    let mut killed_pids = HashSet::new();
    for lease in active {
        if !killed_pids.insert(lease.child_pid) {
            continue;
        }
        let _ = lease
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .kill();
    }

    let Some(manager) = RENDER_WORKER_MANAGER.get() else {
        return;
    };
    manager.notify_cancelled();

    // [PROC-LIFECYCLE FIX 2026-08-28 §UP.4] Trước đây mỗi slot được dọn tuần tự bằng
    // `request(Shutdown)` rồi `child.wait()`, cả hai KHÔNG có trần: `request` chặn ở
    // `read_frame` trên stdout của worker, `wait` chặn đến khi worker chết. Worker kẹt
    // (PDFium đang render trang nặng, pipe đầy, driver treo) ⇒ hàm này không bao giờ trả về
    // ⇒ `RunEvent::Exit` không đi tới `kill_sidecar()` ⇒ app + sidecar còn nguyên trong Task
    // Manager sau khi user đã đóng cửa sổ. Nay: xin thoát êm ở luồng phụ, chờ SONG SONG với
    // một deadline chung, hết hạn thì diệt theo PID.
    let mut clients = Vec::new();
    if let Some(client) = manager
        .interactive
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        clients.push(client);
    }
    for slot in &manager.backgrounds {
        if let Some(client) = slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            clients.push(client);
        }
    }

    let mut pending_shutdowns = Vec::new();
    for mut client in clients {
        let pid = client.child_pid;
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let spawned = std::thread::Builder::new()
            .name("prynx-render-worker-shutdown".to_string())
            .spawn(move || {
                match client.request(&RenderWorkerRequest::Shutdown, None) {
                    Ok(_) => {
                        wait_child_bounded(&client.child, RENDER_WORKER_SHUTDOWN_GRACE);
                    }
                    Err(_) => client.terminate(),
                }
                let _ = done_tx.send(());
            });
        match spawned {
            Ok(_) => pending_shutdowns.push((pid, done_rx)),
            Err(error) => {
                // Không tạo được luồng thì không chờ gì cả — diệt ngay.
                log::warn!(
                    "[RENDER_WORKER] Không tạo được luồng dọn worker PID={pid}: {error}; diệt cứng."
                );
                kill_render_worker_pid(pid);
            }
        }
    }

    let deadline = Instant::now() + RENDER_WORKER_SHUTDOWN_GRACE;
    for (pid, done_rx) in pending_shutdowns {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if done_rx.recv_timeout(remaining).is_err() {
            log::warn!(
                "[RENDER_WORKER] Display worker PID={pid} không thoát trong {} ms; diệt cứng theo PID.",
                RENDER_WORKER_SHUTDOWN_GRACE.as_millis()
            );
            kill_render_worker_pid(pid);
        }
    }
    let notices = priority_preemptions().lock().unwrap_or_else(|p| p.into_inner())
        .drain().map(|(_, notice)| notice).collect::<Vec<_>>();
    for notice in notices { notice.finish(PriorityPreemptionOutcome::Failed); }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "probe pipe thật cần PRYNX_RENDER_WORKER_TEST_EXE/PDF; chỉ worker test"]
    fn client_nhieu_ticket_mot_pipe_va_crash_danh_thuc_moi_waiter() {
        let mut client = spawn_render_worker_client(WorkerLane::Interactive).unwrap();
        let old_pid = client.child_pid;
        let first = client.begin_request(&RenderWorkerRequest::Ping { nonce: "first".into() }, None).unwrap();
        let second = client.begin_request(&RenderWorkerRequest::Ping { nonce: "second".into() }, None).unwrap();
        let second_reply = second.wait().unwrap();
        let first_reply = first.wait().unwrap();
        assert!(matches!(second_reply.header, RenderWorkerResponse::Pong { nonce, worker_pid }
            if nonce == "second" && worker_pid == old_pid));
        assert!(matches!(first_reply.header, RenderWorkerResponse::Pong { nonce, worker_pid }
            if nonce == "first" && worker_pid == old_pid));
        let path = std::env::var("PRYNX_RENDER_WORKER_TEST_PDF").unwrap();
        let token = crate::pdf_file_identity_token(crate::pdf_file_identity(&path).unwrap());
        let request = |id: &str| {
            let mut render = validation_request(&path, token.clone());
            render.request_id = id.into();
            render.session_owner_id = Some("pipe-probe-session".into());
            render.raster = RenderRaster::Dpi { dpi: 96.0, clip: None };
            render.color = RenderColor { pipeline: RenderColorPipeline::Accurate,
                profile_id: Some("fogra39".into()), intent: Some("relative".into()) };
            render.pipeline_identity = RENDER_WORKER_ACCURATE_PIPELINE_ID.into();
            render.soundness = RenderSoundness::ColorVerified;
            RenderWorkerRequest::Render(render)
        };
        let first = client.begin_request(&request("pipe-crash-first"), None).unwrap();
        let second = client.begin_request(&request("pipe-crash-second"), None).unwrap();
        // Dừng đúng child của probe, không dùng tên process hoặc PID app.
        client.child.lock().unwrap().kill().unwrap();
        for ticket in [first, second] {
            assert!(matches!(ticket.response.recv_timeout(Duration::from_secs(5)).unwrap(), Err(_)));
        }
        assert!(!active_render_requests().lock().unwrap().contains_key("pipe-crash-first"));
        assert!(!active_render_requests().lock().unwrap().contains_key("pipe-crash-second"));
        assert!(client.begin_request(&RenderWorkerRequest::Ping { nonce: "dead".into() }, None).is_err());
        drop(client);
        let mut restart = spawn_render_worker_client(WorkerLane::Interactive).unwrap();
        assert_ne!(restart.child_pid, old_pid);
        assert!(matches!(restart.request(&RenderWorkerRequest::Ping { nonce: "restart".into() }, None).unwrap().header,
            RenderWorkerResponse::Pong { nonce, .. } if nonce == "restart"));
        eprintln!("PIPE_MULTIPLEX_PROBE old_pid={old_pid} restart_pid={} queued_tickets=2 reverse_wait=true crash_woke_all=true", restart.child_pid);
    }

    #[test]
    fn accurate_pool_pin_chong_sweep_nhung_last_owner_van_dong_snapshot() {
        let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/../../backend/tests/preflight_fixtures/pdfs/04_font_not_embedded.pdf"));
        let mut pool = AccurateSessionPool::default();
        let key = |name: &str| AccurateSessionKey { document_path: name.into(),
            document_token: "1".into(), profile_path: PathBuf::new(), intent: "relative".into() };
        let make_entry = |owner: Option<&str>, active: usize| {
            let mut session = RenderSession::open_mem(bytes, None).unwrap();
            let job = session.prepare_page_render(1, 72.0, PageBox::Crop,
                RenderOptions::ink_accurate(), None).unwrap();
            let mut owners = AccurateOwnerLeases::default();
            if let Some(owner) = owner { owners.bind(owner, Instant::now()); }
            (AccurateSessionEntry { session, owners, last_used: 0,
                in_flight: Arc::new(AtomicUsize::new(active)) }, job)
        };
        let (own, own_job) = make_entry(Some("owner-a"), 1);
        let (orphan, orphan_job) = make_entry(None, 1);
        let orphan_flight = AccurateRequestLease(orphan.in_flight.clone());
        let (idle, idle_job) = make_entry(None, 0);
        pool.entries.insert(key("own"), own);
        pool.entries.insert(key("orphan-active"), orphan);
        pool.entries.insert(key("idle"), idle);
        assert_eq!(close_ownerless_accurate_sessions(&mut pool), 1);
        assert!(idle_job.ensure_current().is_err());
        assert!(orphan_job.ensure_current().is_ok());
        assert!(!release_accurate_owner_from_pool(&mut pool, "missing"));
        assert!(orphan_job.ensure_current().is_ok(), "release owner khác không được giết job orphan đang pin");
        assert!(release_accurate_owner_from_pool(&mut pool, "owner-a"));
        assert!(own_job.ensure_current().is_err());
        assert!(orphan_job.ensure_current().is_ok());
        drop(orphan_flight);
        assert_eq!(close_ownerless_accurate_sessions(&mut pool), 1);
        assert!(orphan_job.ensure_current().is_err());
    }

    #[test]
    #[ignore = "probe log-only entry PPE native cần PRYNX_RENDER_WORKER_TEST_PDF"]
    fn native_snapshot_raster_nha_pool_va_chay_hai_page() {
        crate::pdf_engine::worker_qos::configure();
        let path = std::env::var("PRYNX_RENDER_WORKER_TEST_PDF").unwrap();
        let token = crate::pdf_file_identity_token(crate::pdf_file_identity(&path).unwrap());
        let canonical = validate_document_path(&path, Some(&token)).unwrap();
        struct Cleanup(String);
        impl Drop for Cleanup { fn drop(&mut self) { close_accurate_sessions_for_path(&self.0); } }
        let _cleanup = Cleanup(canonical.clone());
        let request = |page, dpi, owner: &str| {
            let mut request = validation_request(&path, token.clone());
            request.request_id = format!("native-snapshot-{page}-{dpi}");
            request.session_owner_id = Some(owner.into());
            request.page = page;
            request.raster = RenderRaster::Dpi { dpi, clip: None };
            request.color = RenderColor { pipeline: RenderColorPipeline::Accurate,
                profile_id: Some("fogra39".into()), intent: Some("relative".into()) };
            request.pipeline_identity = RENDER_WORKER_ACCURATE_PIPELINE_ID.into();
            request.soundness = RenderSoundness::ColorVerified;
            request
        };
        let key = AccurateSessionKey { document_path: canonical.clone(), document_token: token.clone(),
            profile_path: accurate_profile_path("fogra39").unwrap(), intent: "relative".into() };
        let origin = Instant::now();
        let spawn = |request| std::thread::spawn(move || {
            let result = super::render_response(request, None);
            (result, origin.elapsed().as_millis())
        });
        let first = spawn(request(1, 92.0, "native-snapshot-main"));
        let mut pool_unlocked_while_pinned = false;
        while !first.is_finished() && origin.elapsed() < Duration::from_secs(60) {
            if let Ok(pool) = accurate_sessions().try_lock() {
                pool_unlocked_while_pinned = pool.entries.get(&key)
                    .is_some_and(|entry| entry.in_flight.load(Ordering::Acquire) > 0);
            }
            if pool_unlocked_while_pinned { break; }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(pool_unlocked_while_pinned, "raster không được giữ pool tới khi trả PNG");
        let second = spawn(request(2, 24.0, "native-snapshot-thumb"));
        let mut overlapped = false;
        while !first.is_finished() && !second.is_finished() && origin.elapsed() < Duration::from_secs(60) {
            if let Ok(pool) = accurate_sessions().try_lock() {
                overlapped |= pool.entries.get(&key)
                    .is_some_and(|entry| entry.in_flight.load(Ordering::Acquire) == 2);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let ((first_response, first_png), first_ms) = first.join().unwrap();
        let ((second_response, second_png), second_ms) = second.join().unwrap();
        assert!(overlapped, "hai page phải thực sự pin cùng session đồng thời");
        assert_eq!(first_response.status, RenderResponseStatus::Ready, "{first_response:?}");
        assert_eq!(second_response.status, RenderResponseStatus::Ready, "{second_response:?}");
        assert_eq!(hex::encode(sha2::Sha256::digest(&first_png)),
            "033c1ab2b4c01f9fccd7e2de4d100180de263085071c620104cf1ecbaa7b38f7");
        let (repeat_response, repeat_png) = super::render_response(request(2, 24.0, "native-snapshot-thumb"), None);
        assert_eq!(repeat_response.status, RenderResponseStatus::Ready);
        assert_eq!(second_png, repeat_png);
        release_accurate_session_owner("native-snapshot-main");
        assert!(accurate_sessions().lock().unwrap().entries.contains_key(&key));
        release_accurate_session_owner("native-snapshot-thumb");
        assert!(!accurate_sessions().lock().unwrap().entries.contains_key(&key));
        let report = serde_json::json!({"scope":"native PPE render_response + PNG; no stdio/client multiplex",
            "pool_unlocked_while_pinned":pool_unlocked_while_pinned, "two_jobs_same_session":overlapped,
            "main_finished_ms":first_ms,"thumbnail_finished_ms":second_ms,
            "main_png_sha256":hex::encode(sha2::Sha256::digest(&first_png)),
            "thumbnail_png_sha256":hex::encode(sha2::Sha256::digest(&second_png)),
            "owner_lifecycle":true,"main_timing":first_response.timing,"thumbnail_timing":second_response.timing,
            "executable_sha256":sha256_file(&std::env::current_exe().unwrap()).unwrap(),
            "pdf_sha256":sha256_file(Path::new(&path)).unwrap()});
        eprintln!("NATIVE_SNAPSHOT_PROBE {report}");
        if let Ok(path) = std::env::var("PRYNX_NATIVE_SNAPSHOT_REPORT") {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).unwrap();
            serde_json::to_writer_pretty(&mut file, &report).unwrap();
        }
    }
    #[test]
    fn serial_document_affinity_chi_opt_in_dev() {
        assert!(!super::serial_document_affinity_for_build(true, None));
        for value in ["", "0", "true", "auto", "invalid"] {
            assert!(!super::serial_document_affinity_for_build(true, Some(value)));
        }
        assert!(super::serial_document_affinity_for_build(true, Some(" 1 ")));
        assert!(!super::serial_document_affinity_for_build(false, Some("1")));
    }
    use super::*;
    use std::io::Cursor;

    #[test]
    fn mode_worker_mac_dinh_auto_va_env_sai_fail_closed_ve_off() {
        assert_eq!(DEFAULT_RENDER_WORKER_MODE, RenderWorkerMode::Auto);
        for raw in ["", "off", "0", "false", "sai"] {
            assert_eq!(parse_render_worker_mode(raw), RenderWorkerMode::Off);
        }
        assert_eq!(parse_render_worker_mode(" AUTO "), RenderWorkerMode::Auto);
        assert_eq!(
            parse_render_worker_mode("required"),
            RenderWorkerMode::Required
        );
    }

    #[test]
    fn mode_viewer_co_ba_trang_thai_va_mac_dinh_giu_current() {
        assert_eq!(DEFAULT_VIEWER_ENGINE_MODE, ViewerEngineMode::Current);
        assert_eq!(
            parse_viewer_engine_mode("current"),
            ViewerEngineMode::Current
        );
        assert_eq!(
            parse_viewer_engine_mode(" HYBRID "),
            ViewerEngineMode::Hybrid
        );
        assert_eq!(
            parse_viewer_engine_mode("ppe-only"),
            ViewerEngineMode::PpeOnly
        );
        assert_eq!(
            parse_viewer_engine_mode("ppe_only"),
            ViewerEngineMode::PpeOnly
        );
        assert_eq!(parse_viewer_engine_mode("sai"), ViewerEngineMode::Current);
        assert_eq!(ViewerEngineMode::PpeOnly.as_str(), "ppe-only");
    }

    #[test]
    fn shadow_render_chi_bat_khi_opt_in_ro_rang() {
        assert!(!parse_shadow_render_enabled(None));
        for raw in ["", "0", "false", "off", "sai"] {
            assert!(!parse_shadow_render_enabled(Some(raw)), "{raw}");
            assert!(!shadow_render_enabled_for_build(true, Some(raw)), "{raw}");
        }
        for raw in ["1", "true", " YES ", "on"] {
            assert!(parse_shadow_render_enabled(Some(raw)), "{raw}");
            assert!(shadow_render_enabled_for_build(true, Some(raw)), "{raw}");
            assert!(!shadow_render_enabled_for_build(false, Some(raw)), "{raw}");
        }
    }

    #[test]
    fn background_lane_theo_tier_ram_va_khong_hard_cap_may_manh() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(background_lane_count_for_hardware(Some(8 * GIB - 1), 16), 0);
        assert_eq!(background_lane_count_for_hardware(Some(8 * GIB), 16), 1);
        assert_eq!(
            background_lane_count_for_hardware(Some(16 * GIB - 1), 16),
            1
        );
        assert_eq!(background_lane_count_for_hardware(Some(16 * GIB), 16), 4);
        assert_eq!(background_lane_count_for_hardware(Some(64 * GIB), 8), 7);
        assert_eq!(background_lane_count_for_hardware(Some(16 * GIB), 1), 1);
        assert_eq!(background_lane_count_for_hardware(None, 12), 11);
        assert_eq!(
            render_request_slots_for_hardware(RenderWorkerMode::Off, Some(64 * GIB), 32),
            4
        );
        assert_eq!(
            render_request_slots_for_hardware(RenderWorkerMode::Required, Some(4 * GIB), 16),
            2
        );
        assert_eq!(
            render_request_slots_for_hardware(RenderWorkerMode::Auto, Some(12 * GIB), 16),
            2
        );
        assert_eq!(
            render_request_slots_for_hardware(RenderWorkerMode::Auto, Some(32 * GIB), 16),
            9
        );
        assert_eq!(parse_background_lane_override(Some("0")), Some(0));
        assert_eq!(parse_background_lane_override(Some(" 12 ")), Some(12));
        assert_eq!(parse_background_lane_override(Some("257")), None);
        assert_eq!(parse_background_lane_override(Some("sai")), None);
    }

    #[test]
    fn document_affinity_tach_snapshot_va_don_dung() {
        let first = RenderDocumentIdentity {
            path: "C:\\jobs\\sample.pdf".to_string(),
            size_bytes: "100".to_string(),
            modified_nanos: "200".to_string(),
            created_nanos: "300".to_string(),
            token: "100:200:300".to_string(),
        };
        let second = RenderDocumentIdentity {
            token: "101:201:301".to_string(),
            ..first.clone()
        };
        let first_key = document_affinity_key(&first);
        let second_key = document_affinity_key(&second);
        assert_ne!(first_key, second_key);

        let mut affinities = HashMap::from([
            (first_key, WorkerLane::Background(0)),
            (second_key, WorkerLane::Background(1)),
            (
                "C:\\jobs\\other.pdf\u{0}1:2:3".to_string(),
                WorkerLane::Background(0),
            ),
        ]);
        clear_document_affinity_for_path(&mut affinities, &first.path, WorkerLane::Background(0));
        clear_document_affinity_for_path(&mut affinities, &first.path, WorkerLane::Background(1));
        assert_eq!(affinities.len(), 1);
        assert!(affinities
            .keys()
            .all(|key| key.starts_with("C:\\jobs\\other.pdf")));
        let tag = document_affinity_tag("C:\\jobs\\sample.pdf\u{0}100:200:300");
        assert_eq!(tag.len(), 12);
        assert!(!tag.contains("sample"));
    }

    #[test]
    fn document_affinity_lookup_va_publish_phai_chung_khoa() {
        let affinities = Mutex::new(HashMap::new());
        let (lane, hit, payload) = reserve_background_affinity(&affinities, Some("doc:1"), || {
            assert!(matches!(affinities.try_lock(), Err(TryLockError::WouldBlock)),
                "request thứ hai có thể lọt vào khoảng lookup → publish");
            (WorkerLane::Background(1), Some("guard đã chọn"))
        });
        assert_eq!(lane, WorkerLane::Background(1));
        assert!(!hit);
        assert_eq!(payload, Some("guard đã chọn"));
        assert!(affinities.try_lock().is_ok(), "không giữ khóa affinity lúc render/chờ lane");
        let (_, hit, payload) = reserve_background_affinity::<()>(&affinities, Some("doc:1"), || {
            panic!("snapshot đã gán không được chọn worker lần nữa")
        });
        assert!(hit);
        assert!(payload.is_none());
    }

    #[test]
    fn document_affinity_request_dong_thoi_chi_chon_mot_worker() {
        let manager = Arc::new(RenderWorkerManager::new(3));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let tasks = (0..8).map(|_| {
            let manager = Arc::clone(&manager);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let (index, hit, _guard) = reserve_background_worker(&manager, Some("same:snapshot"));
                (index, hit)
            })
        }).collect::<Vec<_>>();
        let mut assignments = 0;
        for task in tasks {
            let (index, hit) = task.join().unwrap();
            assert_eq!(index, 0);
            assignments += usize::from(!hit);
        }
        assert_eq!(assignments, 1);
        assert_eq!(manager.next_background.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn document_affinity_file_khac_van_lay_lane_ranh_va_don_dung_lane() {
        let manager = RenderWorkerManager::new(3);
        let (first, _, first_guard) = reserve_background_worker(&manager, Some("doc:a"));
        let (second, _, second_guard) = reserve_background_worker(&manager, Some("doc:b"));
        assert_ne!(first, second, "không gom mọi tài liệu vào một lane");
        retire_worker_affinities(&manager, WorkerLane::Background(second));
        assert!(manager.document_affinity.lock().unwrap().contains_key("doc:a"));
        assert!(!manager.document_affinity.lock().unwrap().contains_key("doc:b"));
        retire_worker_affinities(&manager, WorkerLane::Background(first));
        assert!(!manager.document_affinity.lock().unwrap().contains_key("doc:a"));
        drop(first_guard);
        drop(second_guard);
    }

    #[test]
    fn document_affinity_cho_worker_ban_khong_khoa_registry() {
        let manager = Arc::new(RenderWorkerManager::new(1));
        let busy = manager.backgrounds[0].lock().unwrap();
        let waiter_manager = Arc::clone(&manager);
        let waiter = std::thread::spawn(move || {
            let (index, hit, _guard) = reserve_background_worker(&waiter_manager, Some("doc:waiting"));
            assert!(!hit);
            index
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut visible_while_busy = false;
        while Instant::now() < deadline {
            if let Ok(affinities) = manager.document_affinity.try_lock() {
                if affinities.contains_key("doc:waiting") {
                    visible_while_busy = true;
                    break;
                }
            }
            std::thread::yield_now();
        }
        drop(busy);
        assert_eq!(waiter.join().unwrap(), 0);
        assert!(visible_while_busy, "registry phải rảnh cho cancel/close khi worker còn bận");
    }

    #[test]
    fn document_affinity_khong_identity_va_snapshot_moi_khong_bi_gop() {
        let affinities = Mutex::new(HashMap::new());
        for index in 0..2 {
            let (lane, hit, _) = reserve_background_affinity::<()>(&affinities, None, || {
                assert!(affinities.try_lock().is_ok(), "metadata không cần khóa affinity");
                (WorkerLane::Background(index), None)
            });
            assert_eq!(lane, WorkerLane::Background(index));
            assert!(!hit);
        }
        assert!(affinities.lock().unwrap().is_empty());
        for (index, key) in ["same-path\u{0}1:2:3", "same-path\u{0}4:5:6"].into_iter().enumerate() {
            let (lane, hit, _) = reserve_background_affinity::<()>(&affinities, Some(key), || {
                (WorkerLane::Background(index), None)
            });
            assert_eq!(lane, WorkerLane::Background(index));
            assert!(!hit);
        }
        assert_eq!(affinities.lock().unwrap().len(), 2);
    }

    #[test]
    fn accurate_document_lease_giu_lane_qua_foreground_background_va_owner() {
        let manager = RenderWorkerManager::new(3);
        let now = Instant::now();
        let (lane, hit) = reserve_accurate_lane(&manager, "doc:one", "viewer", RenderPurpose::Interactive, now);
        assert!(!hit);
        assert_eq!(lane, WorkerLane::Interactive);
        let (background, hit) = reserve_accurate_lane(&manager, "doc:one", "thumbnail", RenderPurpose::Background, now);
        assert!(hit);
        assert_eq!(background, lane);
        release_lane_accurate_owner(&manager, lane, "viewer");
        assert!(manager.accurate_document_affinity.lock().unwrap().contains_key("doc:one"));
        release_lane_accurate_owner(&manager, lane, "thumbnail");
        assert!(!manager.accurate_document_affinity.lock().unwrap().contains_key("doc:one"));
    }

    #[test]
    fn accurate_document_lease_background_truoc_foreground_theo_dung_lane() {
        let manager = RenderWorkerManager::new(3);
        let now = Instant::now();
        let (background, _) = reserve_accurate_lane(&manager, "doc:bg-first", "prefetch", RenderPurpose::Background, now);
        assert!(matches!(background, WorkerLane::Background(_)));
        let (foreground, hit) = reserve_accurate_lane(&manager, "doc:bg-first", "viewer", RenderPurpose::Interactive, now);
        assert!(hit);
        assert_eq!(foreground, background);
        assert_eq!(manager.gate(foreground).lane, foreground);
    }

    #[test]
    fn accurate_document_lease_nhieu_file_dung_du_pool_khong_gom_mot_lane() {
        let manager = RenderWorkerManager::new(3);
        let mut counts = HashMap::<String, usize>::new();
        for index in 0..8 {
            let (lane, _) = reserve_accurate_lane(&manager, &format!("doc:{index}"),
                "viewer", RenderPurpose::Interactive, Instant::now());
            *counts.entry(format!("{lane:?}")).or_default() += 1;
        }
        assert_eq!(counts.len(), 4);
        assert!(counts.values().all(|count| *count == 2));
    }

    #[test]
    fn accurate_document_lease_dong_thoi_chi_co_mot_binding() {
        let manager = Arc::new(RenderWorkerManager::new(3));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let tasks = (0..8).map(|index| {
            let manager = Arc::clone(&manager);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                reserve_accurate_lane(&manager, "same-doc", &format!("owner-{index}"),
                    if index % 2 == 0 { RenderPurpose::Interactive } else { RenderPurpose::Background },
                    Instant::now()).0
            })
        }).collect::<Vec<_>>();
        let lanes = tasks.into_iter().map(|task| task.join().unwrap()).collect::<Vec<_>>();
        assert!(lanes.iter().all(|lane| *lane == lanes[0]));
        let entries = manager.accurate_document_affinity.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries["same-doc"].owners.last_seen.len(), 8);
    }

    #[test]
    fn accurate_document_lease_ttl_khong_xoa_render_dang_chay() {
        let manager = RenderWorkerManager::new(2);
        let now = Instant::now();
        let (lane, _) = reserve_accurate_lane(&manager, "active-doc", "owner", RenderPurpose::Interactive, now);
        let flight = pin_accurate_request(&manager, "active-doc", "owner", lane).unwrap();
        let later = Instant::now() + ACCURATE_SESSION_OWNER_TTL + Duration::from_secs(1);
        reserve_accurate_lane(&manager, "other-doc", "other", RenderPurpose::Interactive, later);
        assert!(manager.accurate_document_affinity.lock().unwrap().contains_key("active-doc"));
        drop(flight);
        reserve_accurate_lane(&manager, "other-doc", "other", RenderPurpose::Interactive, later);
        assert!(!manager.accurate_document_affinity.lock().unwrap().contains_key("active-doc"));
    }

    #[test]
    fn accurate_document_lease_revalidate_sau_khi_worker_cu_mat() {
        let manager = RenderWorkerManager::new(2);
        let now = Instant::now();
        let (old, _) = reserve_accurate_lane(&manager, "doc", "owner-a", RenderPurpose::Interactive, now);
        let old_flight = pin_accurate_request(&manager, "doc", "owner-a", old).unwrap();
        retire_worker_affinities(&manager, old);
        let (new, _) = reserve_accurate_lane(&manager, "doc", "owner-b", RenderPurpose::Background, now);
        assert_ne!(new, old);
        assert!(pin_accurate_request(&manager, "doc", "owner-a", old).is_none());
        let new_flight = pin_accurate_request(&manager, "doc", "owner-b", new).unwrap();
        drop(old_flight);
        retire_worker_affinities(&manager, old);
        assert_eq!(manager.accurate_document_affinity.lock().unwrap()["doc"].in_flight.load(Ordering::Acquire), 1);
        drop(new_flight);
    }

    #[test]
    fn accurate_document_lease_close_chi_xoa_path_va_lane_tuong_ung() {
        let manager = RenderWorkerManager::new(2);
        let now = Instant::now();
        let (first, _) = reserve_accurate_lane(&manager, "file-a\u{0}1:2:3", "a", RenderPurpose::Interactive, now);
        let (second, _) = reserve_accurate_lane(&manager, "file-a\u{0}4:5:6", "b", RenderPurpose::Interactive, now);
        reserve_accurate_lane(&manager, "file-b\u{0}1:2:3", "c", RenderPurpose::Interactive, now);
        close_lane_document_affinities(&manager, first, "file-a");
        let entries = manager.accurate_document_affinity.lock().unwrap();
        assert!(!entries.contains_key("file-a\u{0}1:2:3"));
        assert_eq!(entries["file-a\u{0}4:5:6"].lane, second);
        assert!(entries.contains_key("file-b\u{0}1:2:3"));
    }

    #[test]
    fn accurate_document_lease_tach_pipeline_display_va_gate_cua_lane_khac() {
        let manager = RenderWorkerManager::new(2);
        let (ppe, _) = reserve_accurate_lane(&manager, "same-path-token", "ppe-owner",
            RenderPurpose::Interactive, Instant::now());
        let (display_index, _) = reserve_background_lane(&manager, Some("same-path-token"));
        assert_eq!(manager.accurate_document_affinity.lock().unwrap()["same-path-token"].lane, ppe);
        assert_eq!(manager.document_affinity.lock().unwrap()["same-path-token"], WorkerLane::Background(display_index));
        let _busy = acquire_worker_lane(&manager, WorkerLane::Background(0), RenderPurpose::Background, None).unwrap();
        let _other = acquire_worker_lane(&manager, WorkerLane::Background(1), RenderPurpose::Interactive, None).unwrap();
        assert_eq!(manager.gate(WorkerLane::Background(0)).state.lock().unwrap().active_purpose, Some(RenderPurpose::Background));
        let cancelled = AtomicBool::new(true);
        assert!(manager.gate(WorkerLane::Interactive).acquire(RenderPurpose::Interactive, Some(&cancelled)).is_err());
    }

    #[test]
    fn route_bootstrap_interactive_metadata_va_render_nen_dung_purpose() {
        let document = DocumentRequest {
            request_id: "bootstrap-route".to_string(),
            owner_id: "viewer-route".to_string(),
            file_path: "C:\\route.pdf".to_string(),
        };
        assert_eq!(
            request_purpose(&RenderWorkerRequest::Bootstrap(document)),
            RenderPurpose::Interactive
        );
        assert_eq!(
            request_purpose(&RenderWorkerRequest::Metadata(MetadataRequest {
                request_id: "metadata-route".to_string(),
                owner_id: "viewer-route".to_string(),
                file_path: "C:\\route.pdf".to_string(),
                expected_identity: "1:2:3".to_string(),
            })),
            RenderPurpose::Background
        );

        let mut render = validation_request("C:\\route.pdf", "1:2:3".to_string());
        assert_eq!(
            request_purpose(&RenderWorkerRequest::Render(render.clone())),
            RenderPurpose::Interactive
        );
        render.purpose = RenderPurpose::Background;
        assert_eq!(
            request_purpose(&RenderWorkerRequest::Render(render.clone())),
            RenderPurpose::Background
        );
        render.purpose = RenderPurpose::Accurate;
        assert_eq!(
            request_purpose(&RenderWorkerRequest::Render(render.clone())),
            RenderPurpose::Interactive
        );
        render.priority = 100;
        assert_eq!(
            request_purpose(&RenderWorkerRequest::Render(render)),
            RenderPurpose::Background
        );
    }

    #[test]
    fn ppe_prefetch_dung_nguong_lane_cua_viewer() {
        // PERF (audit 2026-09-11 §PPEBX.C): khóa hợp đồng với
        // viewerPageRenderPriority; priority chỉ xếp lane, không đổi pipeline màu.
        for priority in [0, 10, 20, 99] {
            assert_eq!(
                render_lane_purpose(RenderPurpose::Accurate, priority),
                RenderPurpose::Interactive,
                "priority {priority} vẫn thuộc lane tương tác"
            );
        }
        for priority in [100, 200, 1000] {
            assert_eq!(
                render_lane_purpose(RenderPurpose::Accurate, priority),
                RenderPurpose::Background,
                "priority {priority} không được giữ lane tương tác"
            );
        }
        assert_eq!(
            render_lane_purpose(RenderPurpose::Background, 10),
            RenderPurpose::Background
        );
    }

    #[test]
    fn ppe_session_pool_chi_cap_may_yeu_hoac_khi_may_manh_thieu_ram() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(
            accurate_session_limit_for_hardware(Some(6 * GIB), Some(3 * GIB)),
            Some(1)
        );
        assert_eq!(
            accurate_session_limit_for_hardware(Some(12 * GIB), Some(8 * GIB)),
            Some(2)
        );
        assert_eq!(
            accurate_session_limit_for_hardware(Some(32 * GIB), Some(24 * GIB)),
            None
        );
        assert_eq!(
            accurate_session_limit_for_hardware(Some(32 * GIB), Some(3 * GIB)),
            Some(1)
        );
        assert_eq!(accurate_session_limit_for_hardware(None, None), None);
    }

    #[test]
    fn owner_ppe_ref_count_khong_de_tab_nay_dong_session_cua_tab_khac() {
        let started = Instant::now();
        let mut owners = AccurateOwnerLeases::default();
        owners.bind("viewer:tab-a:document-1", started);
        owners.bind("viewer:tab-b:document-1", started);
        owners.bind("viewer:tab-a:document-1", started + Duration::from_secs(1));

        assert_eq!(
            owners.last_seen.len(),
            2,
            "bind lặp không được tăng ref giả"
        );
        assert!(owners.release("viewer:tab-a:document-1"));
        assert!(!owners.is_empty(), "tab B vẫn phải giữ session PPE sống");
        assert!(!owners.release("viewer:tab-khong-ton-tai"));
        assert!(owners.release("viewer:tab-b:document-1"));
        assert!(owners.is_empty());
    }

    #[test]
    fn owner_ppe_webview_crash_duoc_thu_sau_ttl() {
        let started = Instant::now();
        let mut owners = AccurateOwnerLeases::default();
        owners.bind("viewer:webview-crash", started);

        assert_eq!(
            owners.prune_stale(
                started + ACCURATE_SESSION_OWNER_TTL,
                ACCURATE_SESSION_OWNER_TTL
            ),
            0,
            "đúng biên TTL vẫn còn lease"
        );
        assert_eq!(
            owners.prune_stale(
                started + ACCURATE_SESSION_OWNER_TTL + Duration::from_millis(1),
                ACCURATE_SESSION_OWNER_TTL,
            ),
            1
        );
        assert!(owners.is_empty());
    }

    #[test]
    fn profile_fogra39_embedded_duoc_pin_dung_byte() {
        let path = accurate_profile_path("fogra39").expect("materialize FOGRA39 embedded");
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(
            sha2::Sha256::digest(&bytes)[..],
            sha2::Sha256::digest(FOGRA39_ICC_BYTES)[..]
        );
        assert!(accurate_profile_path("../../profile").is_err());
    }

    #[test]
    fn font_du_phong_ppe_embedded_co_fingerprint_co_dinh() {
        let first = ppe_fallback_font();
        let second = ppe_fallback_font();
        assert!(
            Arc::ptr_eq(&first, &second),
            "mọi request phải dùng chung Arc font"
        );
        assert_eq!(
            hex::encode(sha2::Sha256::digest(first.as_slice())),
            PPE_FALLBACK_FONT_SHA256
        );
    }

    #[test]
    fn soundness_duoc_phan_loai_thanh_compatibility_reason_co_cau_truc() {
        let mut image = RenderWarnings::default();
        image.dropped_objects = 1;
        image.note_skipped_op("Do ảnh (codec JPXDecode chưa được hỗ trợ)");
        assert_eq!(
            classify_unsupported_warnings(&image).map(|value| value.0),
            Some(RenderUnsupportedReason::ImageCodec)
        );

        let mut knockout = RenderWarnings {
            unsupported_transparency: true,
            ..Default::default()
        };
        knockout.note_skipped_op("Group /K true (knockout)");
        assert_eq!(
            classify_unsupported_warnings(&knockout).map(|value| value.0),
            Some(RenderUnsupportedReason::KnockoutTransparency)
        );

        let mut color = RenderWarnings::default();
        color.note_approximated_colorspace("BlendMode /Hue ngoài DeviceRGB");
        assert_eq!(
            classify_unsupported_warnings(&color).map(|value| value.0),
            Some(RenderUnsupportedReason::ColorApproximation)
        );

        let mut geometry = RenderWarnings::default();
        geometry.note_substituted_font("FontKhongNhung");
        assert_eq!(
            classify_unsupported_warnings(&geometry).map(|value| value.0),
            None
        );
    }

    #[test]
    fn cancel_bat_duoc_request_dang_cho_lane_va_khong_de_lai_tombstone() {
        let request_id = format!("pending-cancel-{}", std::process::id());
        let lease = PendingWorkerLease::register(&request_id).unwrap();
        assert!(cancel_render_request(&request_id));
        assert!(lease.is_cancelled());
        drop(lease);
        assert!(!cancel_render_request(&request_id));
    }

    #[test]
    fn cooperative_cancel_danh_dung_token_va_de_render_chinh_thu_don() {
        let active = Mutex::new(HashMap::new());
        let token = CancelToken::new();
        active
            .lock()
            .unwrap()
            .insert("ppe-cancel-1".to_string(), token.clone());

        assert!(cancel_worker_token(&active, "ppe-cancel-1"));
        assert!(token.is_cancelled());
        assert!(active.lock().unwrap().contains_key("ppe-cancel-1"));
        assert!(!cancel_worker_token(&active, "ppe-cancel-khong-ton-tai"));
    }

    #[test]
    fn priority_preemption_chi_retry_cancel_noi_bo_khong_nuot_cancel_user() {
        for outcome in [None, Some(PriorityPreemptionOutcome::Failed)] {
            assert!(!priority_retry_for_response(outcome, RenderResponseStatus::Cancelled));
        }
        for outcome in [PriorityPreemptionOutcome::Cooperative, PriorityPreemptionOutcome::Killed] {
            assert!(priority_retry_for_response(Some(outcome), RenderResponseStatus::Cancelled));
            for status in [RenderResponseStatus::Ready, RenderResponseStatus::Error, RenderResponseStatus::Unsupported] {
                assert!(!priority_retry_for_response(Some(outcome), status));
            }
        }
    }

    #[test]
    fn priority_preemption_reply_phai_cho_hanh_dong_preempt_ket_thuc() {
        let notice = Arc::new(PriorityPreemptionNotice::new());
        let completion = PriorityPreemptionCompletion(Arc::clone(&notice));
        let reader_notice = Arc::clone(&notice);
        let (arrived_tx, arrived_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            reader_notice.response_received();
            arrived_tx.send(()).unwrap();
            done_tx.send(reader_notice.wait_outcome()).unwrap();
        });
        arrived_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(notice.wait_for_response(Duration::ZERO));
        assert!(done_rx.try_recv().is_err(), "không nhả slot trước khi preempt xong");
        completion.0.finish(PriorityPreemptionOutcome::Cooperative);
        drop(completion);
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(1)).unwrap(), PriorityPreemptionOutcome::Cooperative);
        reader.join().unwrap();
    }

    #[test]
    fn priority_preemption_deadline_va_cleanup_khong_de_waiter_treo() {
        let notice = Arc::new(PriorityPreemptionNotice::new());
        assert!(!notice.wait_for_response(Duration::ZERO));
        drop(PriorityPreemptionCompletion(Arc::clone(&notice)));
        assert_eq!(notice.wait_outcome(), PriorityPreemptionOutcome::Failed);
    }

    #[test]
    fn priority_preemption_marker_tach_dung_wire_request_trong_cung_pid() {
        let first = register_priority_preemption(u32::MAX, 7);
        let second = register_priority_preemption(u32::MAX, 8);
        first.0.finish(PriorityPreemptionOutcome::Cooperative);
        second.0.finish(PriorityPreemptionOutcome::Killed);
        assert_eq!(take_priority_preemption(u32::MAX, 7), Some(PriorityPreemptionOutcome::Cooperative));
        assert_eq!(take_priority_preemption(u32::MAX, 7), None);
        assert_eq!(take_priority_preemption(u32::MAX, 8), Some(PriorityPreemptionOutcome::Killed));
    }

    #[test]
    fn native_request_id_khong_trung_khi_goi_lien_tiep() {
        let first = native_request_id("metadata");
        let second = native_request_id("metadata");
        assert_ne!(first, second);
    }

    #[test]
    fn shared_lane_chi_cho_background_sau_khi_interactive_nha() {
        let gate = Arc::new(SharedLanePriorityGate::new(WorkerLane::Interactive));
        let interactive = gate
            .acquire(RenderPurpose::Interactive, None)
            .expect("interactive lấy lane");
        let (sender, receiver) = std::sync::mpsc::channel();
        let background_gate = Arc::clone(&gate);
        let waiter = std::thread::spawn(move || {
            let _background = background_gate
                .acquire(RenderPurpose::Background, None)
                .expect("background lấy lane sau");
            sender.send(()).unwrap();
        });
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(30))
            .is_err());
        drop(interactive);
        receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("background phải được đánh thức");
        waiter.join().unwrap();
    }

    #[test]
    #[ignore = "probe riêng cần PRYNX_RENDER_WORKER_TEST_EXE; chỉ dừng worker do test tạo"]
    fn priority_preemption_timeout_chi_dung_worker_rieng() {
        struct Cleanup(RenderWorkerClient);
        impl Drop for Cleanup {
            fn drop(&mut self) { self.0.terminate(); }
        }
        // Worker đã handshake nhưng không có Render: Cancel không tạo reply.
        // Dùng trạng thái idle này để giả lập codec không trả checkpoint.
        let client = Cleanup(spawn_render_worker_client(WorkerLane::Interactive).unwrap());
        let pid = client.0.child_pid;
        let wire_id = client.0.next_request_id;
        register_active_render_request("priority-timeout-probe", ActiveRenderLease {
            child: Arc::clone(&client.0.child), child_pid: pid,
            stdin: Arc::clone(&client.0.stdin), wire_request_id: wire_id,
            lane: WorkerLane::Interactive, purpose: RenderPurpose::Background,
            cooperative_cancel: true,
        });
        let started = Instant::now();
        assert!(preempt_background_on_lane(WorkerLane::Interactive));
        let elapsed = started.elapsed();
        assert!(elapsed >= PPE_PRIORITY_CANCEL_GRACE);
        assert!(elapsed < Duration::from_secs(2), "kill fallback phải có giới hạn");
        assert_eq!(take_priority_preemption(pid, wire_id), Some(PriorityPreemptionOutcome::Killed));
        assert!(client.0.child.lock().unwrap().wait().is_ok());
        assert!(!active_render_requests().lock().unwrap().contains_key("priority-timeout-probe"));
        eprintln!("PPE_PRIORITY_FALLBACK pid={pid} elapsed_ms={} outcome=Killed", elapsed.as_millis());
    }

    #[test]
    #[ignore = "probe riêng cần PRYNX_RENDER_WORKER_TEST_EXE/PDF; không chạy cùng benchmark khác"]
    fn parent_manager_ppe_prefetch_priority_timeline() {
        // PERF (audit 2026-09-11 §PPEBX.C): chạy đúng manager/worker riêng của test,
        // không mở UI hay dừng phiên người dùng. Hai priority giữ cùng PDF/DPI/EXE;
        // ghi wall ở parent vì timing worker không bao gồm chờ mutex của manager.
        struct RuntimeWorkerCleanup;
        impl Drop for RuntimeWorkerCleanup {
            fn drop(&mut self) {
                shutdown_render_worker();
            }
        }

        fn render_probe(
            path: &str,
            page: i32,
            dpi: f32,
            priority: i32,
            request_id: String,
            origin: Instant,
        ) -> Result<(WorkerRenderOutput, u128, u128), String> {
            let context = ViewerRenderContext {
                request_id,
                owner_id: format!("viewer:priority-probe:page-{page}"),
                group_key: format!("page:{page}:accurate-base"),
                generation: 1,
                purpose: RenderPurpose::Accurate,
                priority,
                pipeline_identity: RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string(),
            };
            let started = Instant::now();
            match render_accurate_with_policy(
                path,
                page,
                dpi,
                0,
                None,
                None,
                None,
                None,
                "viewer:priority-probe:session",
                Some(&context),
            )? {
                AccurateWorkerAttempt::Completed(output) => Ok((
                    output,
                    started.elapsed().as_millis(),
                    origin.elapsed().as_millis(),
                )),
                AccurateWorkerAttempt::Unsupported(error) => {
                    Err(format!("PPE unsupported: {error:?}"))
                }
                AccurateWorkerAttempt::FallbackBeforeStart(error) => Err(error),
                AccurateWorkerAttempt::Disabled => Err("PPE worker bị tắt".to_string()),
            }
        }

        let file_path = std::env::var("PRYNX_RENDER_WORKER_TEST_PDF")
            .expect("đặt PRYNX_RENDER_WORKER_TEST_PDF là PDF thật có ít nhất 3 trang");
        let worker_executable = std::env::var_os("PRYNX_RENDER_WORKER_TEST_EXE")
            .map(PathBuf::from)
            .expect("đặt PRYNX_RENDER_WORKER_TEST_EXE trỏ đúng binary đã build");
        let read_page = |key: &str, fallback: i32| {
            std::env::var(key)
                .ok()
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(fallback)
        };
        let active_page = read_page("PRYNX_RENDER_WORKER_TEST_PAGE", 1);
        let prefetch_page = read_page("PRYNX_RENDER_WORKER_TEST_PREFETCH_PAGE", 3);
        let samples = read_page("PRYNX_RENDER_WORKER_PRIORITY_SAMPLES", 1) as usize;
        let dpi = 96.0;
        assert_ne!(render_worker_mode(), RenderWorkerMode::Off);
        let _cleanup = RuntimeWorkerCleanup;
        let lanes = configured_background_lane_count();
        let pdf_sha256 = sha256_file(Path::new(&file_path)).expect("hash PDF mẫu");
        let worker_sha256 = sha256_file(&worker_executable).expect("hash worker trước probe");
        let mut rows = Vec::new();
        let mut active_reference = None;
        let mut prefetch_reference = None;

        for sample in 0..samples {
            // Đảo thứ tự giữa các cặp để không luôn cho bản mới hưởng OS cache sau.
            let priorities = if sample % 2 == 0 {
                [20, 100]
            } else {
                [100, 20]
            };
            for prefetch_priority in priorities {
                let _ = close_document_with_policy(&file_path).expect("nhả session giữa hai ca");
                let origin = Instant::now();
                let preemptions_before = BACKGROUND_PREEMPTION_COUNT.load(Ordering::Relaxed);
                let prefetch_id = format!("priority-probe-{sample}-{prefetch_priority}-prefetch");
                let background_id = prefetch_id.clone();
                let background_path = file_path.clone();
                let (background_tx, background_rx) = mpsc::channel();
                let background = std::thread::spawn(move || {
                    let result = render_probe(
                        &background_path,
                        prefetch_page,
                        dpi,
                        prefetch_priority,
                        background_id,
                        origin,
                    );
                    let _ = background_tx.send(result);
                });
                let prefetch_lease = loop {
                    let lease = active_render_requests()
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .get(&prefetch_id)
                        .map(|lease| (lease.child_pid, lease.lane));
                    if let Some(lease) = lease {
                        break lease;
                    }
                    if let Ok(result) = background_rx.try_recv() {
                        panic!(
                            "prefetch đã kết thúc trước khi probe thấy lease: {}",
                            result
                                .err()
                                .unwrap_or_else(|| "dùng trang mẫu phức tạp hơn".to_string())
                        );
                    }
                    assert!(
                        origin.elapsed() < Duration::from_secs(30),
                        "prefetch không đăng ký lease"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                };
                let prefetch_registered_ms = origin.elapsed().as_millis();
                let expected_prefetch_lane = if prefetch_priority >= 100 && lanes > 0 {
                    matches!(prefetch_lease.1, WorkerLane::Background(_))
                } else {
                    prefetch_lease.1 == WorkerLane::Interactive
                };
                assert!(
                    expected_prefetch_lane,
                    "prefetch phải vào đúng lane đã phân loại"
                );

                let active_id = format!("priority-probe-{sample}-{prefetch_priority}-active");
                let foreground_id = active_id.clone();
                let foreground_path = file_path.clone();
                let active_submitted_ms = origin.elapsed().as_millis();
                let (foreground_tx, foreground_rx) = mpsc::channel();
                let foreground = std::thread::spawn(move || {
                    let result = render_probe(
                        &foreground_path,
                        active_page,
                        dpi,
                        10,
                        foreground_id,
                        origin,
                    );
                    let _ = foreground_tx.send(result);
                });
                let mut active_registered = None;
                let active_result = loop {
                    if active_registered.is_none() {
                        active_registered = active_render_requests()
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .get(&active_id)
                            .map(|lease| {
                                (lease.child_pid, lease.lane, origin.elapsed().as_millis())
                            });
                    }
                    match foreground_rx.recv_timeout(Duration::from_millis(1)) {
                        Ok(result) => break result.expect("active phải dựng thành công"),
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            assert!(
                                origin.elapsed() < Duration::from_secs(60),
                                "active không hoàn tất"
                            );
                        }
                        Err(error) => panic!("thread active không trả kết quả: {error}"),
                    }
                };
                foreground.join().expect("thread active không panic");
                let background_result = background_rx
                    .recv_timeout(Duration::from_secs(60))
                    .expect("prefetch phải hoàn tất hoặc retry sau preempt")
                    .expect("prefetch phải dựng thành công");
                background.join().expect("thread prefetch không panic");
                if let Some((pid, lane, _)) = active_registered {
                    assert_eq!(lane, if serial_document_affinity_enabled() { prefetch_lease.1 }
                        else { WorkerLane::Interactive }, "foreground phải theo chính sách lane đã chọn");
                    if prefetch_priority >= 100 && serial_document_affinity_enabled() {
                        assert_eq!(pid, prefetch_lease.0,
                            "PPE nhường lane bằng CancelToken phải giữ process/session sống");
                    }
                }
                let (active, active_wall_ms, active_finished_ms) = active_result;
                let (prefetch, prefetch_wall_ms, prefetch_finished_ms) = background_result;
                if prefetch_priority >= 100 && (serial_document_affinity_enabled() || lanes == 0) {
                    assert!(BACKGROUND_PREEMPTION_COUNT.load(Ordering::Relaxed) > preemptions_before,
                        "foreground phải thực sự preempt background trên lane affined");
                    assert!(active_finished_ms <= prefetch_finished_ms,
                        "background phải nhường cho foreground hoàn tất trước");
                }
                assert_eq!(active.response.soundness, RenderSoundness::ColorVerified);
                assert_eq!(prefetch.response.soundness, RenderSoundness::ColorVerified);
                let active_hash = hex::encode(sha2::Sha256::digest(&active.bytes));
                let prefetch_hash = hex::encode(sha2::Sha256::digest(&prefetch.bytes));
                assert_eq!(
                    active_reference.get_or_insert(active_hash.clone()),
                    &active_hash
                );
                assert_eq!(
                    prefetch_reference.get_or_insert(prefetch_hash.clone()),
                    &prefetch_hash
                );
                rows.push(serde_json::json!({
                    "sample": sample,
                    "prefetch_priority": prefetch_priority,
                    "prefetch_page": prefetch_page,
                    "active_page": active_page,
                    "active_priority": 10,
                    "dpi": dpi,
                    "prefetch_lane": format!("{:?}", prefetch_lease.1),
                    "prefetch_worker_pid": prefetch_lease.0,
                    "prefetch_registered_ms": prefetch_registered_ms,
                    "active_submitted_ms": active_submitted_ms,
                    "active_registered_ms": active_registered.map(|value| value.2),
                    "active_worker_pid": active_registered.map(|value| value.0),
                    "active_lane": active_registered.map(|value| format!("{:?}", value.1)),
                    "active_parent_wall_ms": active_wall_ms,
                    "active_finished_ms": active_finished_ms,
                    "prefetch_parent_wall_ms": prefetch_wall_ms,
                    "prefetch_finished_ms": prefetch_finished_ms,
                    "active_worker_timing": active.response.timing,
                    "prefetch_worker_timing": prefetch.response.timing,
                    "active_png_sha256": active_hash,
                    "prefetch_png_sha256": prefetch_hash,
                    "background_preemptions": BACKGROUND_PREEMPTION_COUNT.load(Ordering::Relaxed)
                        .saturating_sub(preemptions_before),
                }));
            }
        }
        assert_eq!(
            sha256_file(Path::new(&file_path)).expect("hash PDF sau probe"),
            pdf_sha256
        );
        assert_eq!(
            sha256_file(&worker_executable).expect("hash worker sau probe"),
            worker_sha256
        );
        let report = serde_json::json!({
            "probe": "PPEBX.C-parent-manager-priority",
            "pdf_sha256": pdf_sha256,
            "worker_sha256": worker_sha256,
            "background_lanes": lanes,
            "serial_document_affinity": serial_document_affinity_enabled(),
            "samples_per_priority": samples,
            "rows": rows,
        });
        let report = serde_json::to_string_pretty(&report).expect("mã hóa báo cáo probe");
        eprintln!("PPE_PRIORITY_TIMELINE {report}");
        if let Ok(path) = std::env::var("PRYNX_RENDER_WORKER_PRIORITY_REPORT") {
            std::fs::write(path, report).expect("ghi báo cáo probe riêng");
        }
    }

    #[test]
    #[ignore = "benchmark log-only cần PRYNX_RENDER_WORKER_TEST_EXE/PDF"]
    fn parent_manager_log_only_baseline() {
        // PERF (audit 2026-09-23 §R23.LOG-ONLY): chỉ manager/worker riêng của test.
        // Không gọi Tauri UI, không xóa cache của process PrynX đang mở.
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) { shutdown_render_worker(); }
        }
        let _cleanup = Cleanup;
        let path = std::env::var("PRYNX_RENDER_WORKER_TEST_PDF").expect("thiếu PDF benchmark");
        let executable = PathBuf::from(std::env::var_os("PRYNX_RENDER_WORKER_TEST_EXE")
            .expect("thiếu worker benchmark"));
        let samples: usize = std::env::var("PRYNX_RENDER_WORKER_LOG_SAMPLES")
            .unwrap_or_else(|_| "30".into()).parse().expect("samples phải là số nguyên");
        assert!(samples > 0);
        assert_eq!(render_worker_mode(), RenderWorkerMode::Required,
            "benchmark phải fail-closed, không tự lùi engine");
        let pdf_hash = sha256_file(Path::new(&path)).unwrap();
        let worker_hash = sha256_file(&executable).unwrap();
        let identity = crate::pdf_file_identity_token(crate::pdf_file_identity(&path).unwrap());
        let affinity_key = format!("{path}\u{0}{identity}");
        let mut rows = Vec::new();
        let mut reference = HashMap::new();
        let phases = [
            ("cold_full", 92.0, 10, None),
            ("warm_full", 92.0, 10, None),
            ("warm_tile", 188.0, 10, Some((1024, 512, 512, 512))),
            ("background_thumbnail_first", 24.0, 500, None),
            ("background_thumbnail_repeat", 24.0, 500, None),
        ];
        for sample in 0..samples {
            let reset = close_document_with_policy(&path).expect("không đóng được cache của probe");
            assert!(matches!(reset, WorkerAttempt::Completed(_)));
            let mut document_worker_pid = None;
            for (phase, dpi, priority, clip) in phases {
                let request_id = format!("log-probe-{}-{sample}-{phase}", std::process::id());
                let context = ViewerRenderContext {
                    request_id: request_id.clone(),
                    owner_id: "viewer:log-probe".into(),
                    group_key: format!("page:1:{phase}"),
                    generation: sample as u64 + 1,
                    purpose: RenderPurpose::Accurate,
                    priority,
                    pipeline_identity: RENDER_WORKER_ACCURATE_PIPELINE_ID.into(),
                };
                let started = Instant::now();
                let attempt = render_accurate_with_policy(
                    &path, 1, dpi, 0, clip.map(|c| c.0), clip.map(|c| c.1),
                    clip.map(|c| c.2), clip.map(|c| c.3), "viewer:log-probe:session",
                    Some(&context),
                );
                let parent_wall_ms = started.elapsed().as_secs_f64() * 1000.0;
                let output = match attempt {
                    Ok(AccurateWorkerAttempt::Completed(output)) => output,
                    other => {
                        eprintln!("PPE_LOG_BASELINE_FAILURE sample={sample} phase={phase}");
                        match other {
                            Err(error) => panic!("render thất bại: {error}"),
                            Ok(AccurateWorkerAttempt::Unsupported(error)) => panic!("unsupported: {error:?}"),
                            _ => panic!("benchmark không được fallback/disabled"),
                        }
                    }
                };
                assert_eq!(output.response.status, RenderResponseStatus::Ready);
                assert_eq!(output.response.soundness, RenderSoundness::ColorVerified);
                assert_eq!(output.response.pipeline_identity, RENDER_WORKER_ACCURATE_PIPELINE_ID);
                let png_hash = hex::encode(sha2::Sha256::digest(&output.bytes));
                let pixel_key = format!("{dpi}:{clip:?}");
                assert_eq!(reference.entry(pixel_key).or_insert_with(|| png_hash.clone()), &png_hash,
                    "PNG phải khớp giữa cold/warm, lane và các lượt");
                let manager = render_worker_manager();
                let lane = if serial_document_affinity_enabled() {
                    manager.accurate_document_affinity.lock().unwrap()
                        .get(&affinity_key).expect("PPE phải có lease tài liệu").lane
                } else if priority >= 100 && !manager.backgrounds.is_empty() {
                    *manager.document_affinity.lock().unwrap().get(&affinity_key)
                        .expect("PPE nền phải có affinity khi dùng pool nền")
                } else { WorkerLane::Interactive };
                let slot = match lane {
                    WorkerLane::Interactive => &manager.interactive,
                    WorkerLane::Background(index) => &manager.backgrounds[index],
                };
                let worker_pid = slot.lock().unwrap().as_ref().expect("worker còn sống").child_pid;
                if serial_document_affinity_enabled() {
                    assert_eq!(*document_worker_pid.get_or_insert(worker_pid), worker_pid,
                        "PPE foreground/background cùng snapshot phải dùng chung worker/session");
                }
                let row = serde_json::json!({
                    "sample": sample + 1, "phase": phase, "page": 1, "dpi": dpi,
                    "clip": clip, "priority": priority, "request_id": request_id,
                    "parent_wall_ms": parent_wall_ms, "worker_timing": output.response.timing,
                    "worker_pid": worker_pid, "lane": format!("{lane:?}"),
                    "bitmap_width": output.response.bitmap_width,
                    "bitmap_height": output.response.bitmap_height,
                    "png_bytes": output.bytes.len(), "png_sha256": png_hash,
                    "geometry_approximated": output.response.geometry_approximated,
                });
                eprintln!("PPE_LOG_BASELINE_ROW {row}");
                rows.push(row);
            }
        }
        assert_eq!(sha256_file(Path::new(&path)).unwrap(), pdf_hash);
        assert_eq!(sha256_file(&executable).unwrap(), worker_hash);
        let report = serde_json::json!({
            "schema_version": 1, "scope": "headless-native-manager-worker-png",
            "samples_per_phase": samples, "complete": true,
            "cold_kind": "document-session-cleared; worker-process-and-OS-cache-retained",
            "serial_document_affinity": serial_document_affinity_enabled(),
            "background_session": if serial_document_affinity_enabled() {
                "same PPE document lease as foreground; first background request already reuses the session"
            } else { "legacy separate interactive/background lanes; first background session is cold when background lanes exist" },
            "excludes": ["Tauri IPC entry", "WebView", "DOM", "decode", "compositor", "actual sidebar"],
            "pdf_sha256": pdf_hash, "worker_sha256": worker_hash,
            "parent_sha256": sha256_file(&std::env::current_exe().unwrap()).unwrap(),
            "background_lanes": configured_background_lane_count(), "rows": rows,
        });
        if let Ok(path) = std::env::var("PRYNX_RENDER_WORKER_LOG_REPORT") {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)
                .expect("report phải là file mới, không ghi đè lượt trước");
            serde_json::to_writer_pretty(&mut file, &report).unwrap();
        }
        eprintln!("PPE_LOG_BASELINE_COMPLETE samples={samples}");
    }

    #[test]
    #[ignore = "runtime log-only cần PRYNX_RENDER_WORKER_TEST_EXE/PDF; worker riêng"]
    fn parent_manager_shared_documents_owners_and_restart() {
        assert!(serial_document_affinity_enabled(), "probe yêu cầu PRYNX_PPE_SERIAL_DOCUMENT_AFFINITY=1 trong dev");
        struct Cleanup;
        impl Drop for Cleanup { fn drop(&mut self) { shutdown_render_worker(); } }
        let _cleanup = Cleanup;
        assert!(configured_background_lane_count() > 0, "probe hai tài liệu cần pool nhiều lane");
        let first_path = std::env::var("PRYNX_RENDER_WORKER_TEST_PDF").unwrap();
        let second_path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
            .join("backend/tests/preflight_fixtures/pdfs/13_multipage_15.pdf")
            .to_string_lossy().into_owned();
        fn key(path: &str) -> String {
            format!("{path}\u{0}{}", crate::pdf_file_identity_token(crate::pdf_file_identity(path).unwrap()))
        }
        fn render(path: &str, owner: &str, suffix: &str, priority: i32) -> Result<(String, u32, WorkerLane), String> {
            let context = ViewerRenderContext {
                request_id: format!("shared-doc-{}-{suffix}", std::process::id()),
                owner_id: owner.to_string(), group_key: "page:1:shared-doc-probe".into(),
                generation: 1, purpose: RenderPurpose::Accurate, priority,
                pipeline_identity: RENDER_WORKER_ACCURATE_PIPELINE_ID.into(),
            };
            let result = render_accurate_with_policy(path, 1, 24.0, 0,
                None, None, None, None, owner, Some(&context))?;
            let AccurateWorkerAttempt::Completed(output) = result else { return Err("PPE không được fallback".into()); };
            assert_eq!(output.response.status, RenderResponseStatus::Ready);
            assert_eq!(output.response.soundness, RenderSoundness::ColorVerified);
            let manager = render_worker_manager();
            let lane = manager.accurate_document_affinity.lock().unwrap()[&key(path)].lane;
            let pid = manager.slot(lane).lock().unwrap().as_ref().unwrap().child_pid;
            Ok((hex::encode(sha2::Sha256::digest(&output.bytes)), pid, lane))
        }
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let first_barrier = Arc::clone(&barrier);
        let first_thread_path = first_path.clone();
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            render(&first_thread_path, "shared-doc-owner-a", "first-a", 10)
        });
        let second_barrier = Arc::clone(&barrier);
        let second_thread_path = second_path.clone();
        let second = std::thread::spawn(move || {
            second_barrier.wait();
            render(&second_thread_path, "shared-doc-owner-b", "first-b", 10)
        });
        let first_id = format!("shared-doc-{}-first-a", std::process::id());
        let second_id = format!("shared-doc-{}-first-b", std::process::id());
        barrier.wait();
        let started = Instant::now();
        let mut overlapped = false;
        while !first.is_finished() || !second.is_finished() {
            {
                let active = active_render_requests().lock().unwrap();
                overlapped |= active.contains_key(&first_id) && active.contains_key(&second_id);
            }
            assert!(started.elapsed() < Duration::from_secs(30), "hai render phải kết thúc");
            std::thread::sleep(Duration::from_millis(1));
        }
        let (first_hash, first_pid, first_lane) = first.join().unwrap().unwrap();
        let (second_hash, second_pid, second_lane) = second.join().unwrap().unwrap();
        assert_ne!(first_pid, second_pid, "hai tài liệu phải dùng được hai worker");
        assert!(overlapped, "lease render phải thực sự chồng thời gian");
        let (thumb_hash, thumb_pid, _) = render(&first_path, "shared-doc-thumb-a", "thumb-a", 500).unwrap();
        assert_eq!(thumb_hash, first_hash);
        assert_eq!(thumb_pid, first_pid);
        release_accurate_session_owner_with_policy("shared-doc-owner-a").unwrap();
        assert!(render_worker_manager().accurate_document_affinity.lock().unwrap().contains_key(&key(&first_path)));
        let (after_release_hash, after_release_pid, _) = render(&first_path, "shared-doc-thumb-a", "thumb-after-release", 500).unwrap();
        assert_eq!(after_release_hash, first_hash);
        assert_eq!(after_release_pid, first_pid);
        release_accurate_session_owner_with_policy("shared-doc-thumb-a").unwrap();
        assert!(!render_worker_manager().accurate_document_affinity.lock().unwrap().contains_key(&key(&first_path)));
        assert!(render_worker_manager().accurate_document_affinity.lock().unwrap().contains_key(&key(&second_path)));
        {
            // Chỉ kill worker do probe sở hữu để kiểm đường crash/restart.
            let slot = render_worker_manager().slot(second_lane).lock().unwrap();
            slot.as_ref().unwrap().child.lock().unwrap().kill().unwrap();
        }
        assert!(render(&second_path, "shared-doc-owner-b", "detect-crash", 10).is_err());
        let (restarted_hash, restarted_pid, _) = render(&second_path, "shared-doc-owner-b", "after-restart", 10).unwrap();
        assert_eq!(restarted_hash, second_hash);
        assert_ne!(restarted_pid, second_pid);
        release_accurate_session_owner_with_policy("shared-doc-owner-b").unwrap();
        let report = serde_json::json!({
            "scope": "headless-shared-document-owner-lifecycle",
            "documents_overlapped": overlapped, "first_worker_pid": first_pid,
            "second_worker_pid": second_pid, "first_lane": format!("{first_lane:?}"),
            "second_lane": format!("{second_lane:?}"), "thumbnail_worker_pid": thumb_pid,
            "other_owner_release_keeps_worker": after_release_pid == first_pid,
            "last_owner_releases_binding": true, "restart_worker_pid": restarted_pid,
            "png_parity": true,
        });
        eprintln!("PPE_SHARED_DOCUMENTS {report}");
        if let Ok(path) = std::env::var("PRYNX_RENDER_WORKER_SHARED_REPORT") {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).unwrap();
            serde_json::to_writer_pretty(&mut file, &report).unwrap();
        }
    }

    #[test]
    #[ignore = "runtime thủ công cần PRYNX_RENDER_WORKER_TEST_EXE/PDF và FOGRA39"]
    fn parent_manager_render_ppe_accurate_pdf_that() {
        let file_path = std::env::var("PRYNX_RENDER_WORKER_TEST_PDF")
            .expect("đặt PRYNX_RENDER_WORKER_TEST_PDF");
        let page = std::env::var("PRYNX_RENDER_WORKER_TEST_PAGE")
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(1);
        assert_ne!(render_worker_mode(), RenderWorkerMode::Off);
        let context = ViewerRenderContext {
            request_id: "ppe-runtime-accurate".to_string(),
            owner_id: "viewer:ppe-runtime".to_string(),
            group_key: "page:1:accurate-base".to_string(),
            generation: 1,
            purpose: RenderPurpose::Interactive,
            priority: 0,
            pipeline_identity: RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string(),
        };
        let AccurateWorkerAttempt::Completed(output) = render_accurate_with_policy(
            &file_path,
            page,
            96.0,
            0,
            None,
            None,
            None,
            None,
            "viewer:ppe-runtime:session",
            Some(&context),
        )
        .expect("PPE worker phải dựng được PDF thật") else {
            panic!("PPE worker mode required không được fallback");
        };
        assert_eq!(&output.bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            output.response.pipeline_identity,
            RENDER_WORKER_ACCURATE_PIPELINE_ID
        );
        assert_eq!(output.response.soundness, RenderSoundness::ColorVerified);
        assert_eq!(output.response.status, RenderResponseStatus::Ready);
        if let Ok(output_path) = std::env::var("PRYNX_RENDER_WORKER_TEST_OUTPUT") {
            std::fs::write(output_path, &output.bytes).expect("ghi PNG runtime của PPE worker");
        }
        eprintln!(
            "PPE worker 96 DPI: total={}ms render={:?}ms encode={:?}ms bytes={}",
            output.response.timing.total_ms,
            output.response.timing.render_ms,
            output.response.timing.encode_ms,
            output.bytes.len()
        );
        let warm_context = ViewerRenderContext {
            request_id: "ppe-runtime-accurate-warm".to_string(),
            generation: 2,
            ..context
        };
        let AccurateWorkerAttempt::Completed(warm) = render_accurate_with_policy(
            &file_path,
            page,
            96.0,
            0,
            None,
            None,
            None,
            None,
            "viewer:ppe-runtime:session",
            Some(&warm_context),
        )
        .expect("PPE worker phải tái dùng session ở lượt warm") else {
            panic!("PPE worker warm không được fallback");
        };
        assert_eq!(warm.response.status, RenderResponseStatus::Ready);
        assert!(
            warm.response.timing.total_ms <= output.response.timing.total_ms,
            "session warm không được chậm hơn cold trên cùng PDF/DPI"
        );
        eprintln!(
            "PPE worker warm 96 DPI: total={}ms render={:?}ms encode={:?}ms bytes={}",
            warm.response.timing.total_ms,
            warm.response.timing.render_ms,
            warm.response.timing.encode_ms,
            warm.bytes.len()
        );

        let worker_pid_before = render_worker_manager()
            .interactive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .expect("PPE warm phải giữ worker tương tác")
            .child_pid;
        let cancel_path = file_path.clone();
        let (done_sender, done_receiver) = mpsc::channel();
        let cancelled_render = std::thread::spawn(move || {
            let cancel_context = ViewerRenderContext {
                request_id: "ppe-runtime-cooperative-cancel".to_string(),
                owner_id: "viewer:ppe-runtime".to_string(),
                group_key: "page:1:accurate-viewport".to_string(),
                generation: 3,
                purpose: RenderPurpose::Interactive,
                priority: 0,
                pipeline_identity: RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string(),
            };
            let result = render_accurate_with_policy(
                &cancel_path,
                1,
                600.0,
                0,
                Some(0),
                Some(0),
                Some(1600),
                Some(900),
                "viewer:ppe-runtime:session",
                Some(&cancel_context),
            );
            done_sender.send(result).unwrap();
        });
        let mut registered = false;
        for _ in 0..200 {
            registered = active_render_requests()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get("ppe-runtime-cooperative-cancel")
                .is_some_and(|lease| lease.cooperative_cancel);
            if registered {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            registered,
            "PPE phải đăng ký lease cooperative trước khi hủy"
        );
        let cancel_started = Instant::now();
        assert!(cancel_render_request("ppe-runtime-cooperative-cancel"));
        assert!(done_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("PPE stale phải thoát có giới hạn")
            .is_err());
        cancelled_render.join().unwrap();

        let manager_guard = render_worker_manager()
            .interactive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let client = manager_guard
            .as_ref()
            .expect("cooperative cancel không được xóa worker khỏi slot");
        assert_eq!(client.child_pid, worker_pid_before);
        assert!(client
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .try_wait()
            .unwrap()
            .is_none());
        eprintln!(
            "PPE cooperative cancel: {}ms, worker pid={} vẫn sống",
            cancel_started.elapsed().as_millis(),
            worker_pid_before
        );
        drop(manager_guard);

        let resume_context = ViewerRenderContext {
            request_id: "ppe-runtime-after-cancel".to_string(),
            owner_id: "viewer:ppe-runtime".to_string(),
            group_key: "page:1:accurate-base".to_string(),
            generation: 4,
            purpose: RenderPurpose::Interactive,
            priority: 0,
            pipeline_identity: RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string(),
        };
        let AccurateWorkerAttempt::Completed(resumed) = render_accurate_with_policy(
            &file_path,
            1,
            96.0,
            0,
            None,
            None,
            None,
            None,
            "viewer:ppe-runtime:session",
            Some(&resume_context),
        )
        .expect("request sau cancel phải tái dùng worker/session") else {
            panic!("PPE sau cancel không được fallback");
        };
        assert_eq!(resumed.response.status, RenderResponseStatus::Ready);
        assert!(
            resumed.response.timing.total_ms <= output.response.timing.total_ms,
            "render sau cancel phải còn là session warm, không được rơi về cold"
        );
        eprintln!(
            "PPE sau cancel: total={}ms render={:?}ms encode={:?}ms",
            resumed.response.timing.total_ms,
            resumed.response.timing.render_ms,
            resumed.response.timing.encode_ms
        );
        assert_eq!(
            render_worker_manager()
                .interactive
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .unwrap()
                .child_pid,
            worker_pid_before
        );
        shutdown_render_worker();
    }

    #[test]
    #[ignore = "runtime thủ công cần PRYNX_RENDER_WORKER_TEST_EXE/PDF và mode auto/required"]
    fn parent_manager_spawn_va_render_pdf_that() {
        let file_path = std::env::var("PRYNX_RENDER_WORKER_TEST_PDF")
            .expect("đặt PRYNX_RENDER_WORKER_TEST_PDF");
        assert_ne!(render_worker_mode(), RenderWorkerMode::Off);
        let WorkerAttempt::Completed(bootstrap) =
            bootstrap_with_policy(&file_path).expect("worker manager bootstrap")
        else {
            panic!("mode worker phải bootstrap bằng process riêng");
        };
        let identity = bootstrap["fileIdentity"]
            .as_str()
            .expect("bootstrap có identity");
        let WorkerAttempt::Completed(metadata) =
            metadata_with_policy(&file_path, identity).expect("worker manager metadata")
        else {
            panic!("mode worker phải hydrate metadata bằng process riêng");
        };
        assert_eq!(bootstrap["numPages"], metadata["numPages"]);
        if configured_background_lane_count() > 0 {
            assert!(
                render_worker_manager().backgrounds.iter().any(|slot| slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .is_some()),
                "metadata phải làm nóng ít nhất một background worker"
            );
        }
        let attempt =
            render_display_with_policy(&file_path, 1, 0.5, 0, None, None, None, None, None)
                .expect("worker manager render");
        let WorkerAttempt::Completed(output) = attempt else {
            panic!("mode worker phải render bằng process riêng");
        };
        assert_eq!(&output.bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(output.response.status, RenderResponseStatus::Ready);

        if configured_background_lane_count() == 0 {
            struct RuntimePdfCopy(PathBuf);
            impl Drop for RuntimePdfCopy {
                fn drop(&mut self) {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
            let temp_path = std::env::temp_dir().join(format!(
                "prynx_render_preempt_{}_{}.pdf",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::copy(&file_path, &temp_path).expect("tạo bản PDF riêng cho ca preempt");
            let temp_pdf = RuntimePdfCopy(temp_path);
            let preempt_path = temp_pdf.0.to_string_lossy().into_owned();
            let background_path = preempt_path.clone();
            let preemptions_before = BACKGROUND_PREEMPTION_COUNT.load(Ordering::Relaxed);
            let background = std::thread::spawn(move || {
                let context = ViewerRenderContext {
                    request_id: "preempt-runtime-background".to_string(),
                    owner_id: "viewer:preempt-test".to_string(),
                    group_key: "page:1:background".to_string(),
                    generation: 1,
                    purpose: RenderPurpose::Background,
                    priority: 100,
                    pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
                };
                render_display_with_policy(
                    &background_path,
                    1,
                    8.0,
                    0,
                    None,
                    None,
                    None,
                    None,
                    Some(&context),
                )
            });
            let mut background_registered = false;
            for _ in 0..400 {
                background_registered = active_render_requests()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get("preempt-runtime-background")
                    .is_some_and(|lease| lease.purpose == RenderPurpose::Background);
                if background_registered {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            assert!(
                background_registered,
                "background phải đăng ký lease trước ca preempt"
            );

            let interactive_context = ViewerRenderContext {
                request_id: "preempt-runtime-interactive".to_string(),
                owner_id: "viewer:preempt-test".to_string(),
                group_key: "page:1:interactive".to_string(),
                generation: 1,
                purpose: RenderPurpose::Interactive,
                priority: 0,
                pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
            };
            assert!(matches!(
                render_display_with_policy(
                    &preempt_path,
                    1,
                    0.5,
                    0,
                    None,
                    None,
                    None,
                    None,
                    Some(&interactive_context),
                )
                .expect("interactive phải preempt background"),
                WorkerAttempt::Completed(_)
            ));
            assert!(
                BACKGROUND_PREEMPTION_COUNT.load(Ordering::Relaxed) > preemptions_before,
                "interactive phải thực sự kill background lease"
            );
            assert!(matches!(
                background
                    .join()
                    .expect("thread background")
                    .expect("background phải retry an toàn"),
                WorkerAttempt::Completed(_)
            ));
            let _ = close_document_with_policy(&preempt_path);
        }

        let cancel_path = file_path.clone();
        let cancelled_render = std::thread::spawn(move || {
            let context = ViewerRenderContext {
                request_id: "cancel-runtime-render".to_string(),
                owner_id: "viewer:cancel-test".to_string(),
                group_key: "page:1:page".to_string(),
                generation: 2,
                purpose: RenderPurpose::Interactive,
                priority: 0,
                pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
            };
            render_display_with_policy(
                &cancel_path,
                1,
                16.0,
                0,
                None,
                None,
                None,
                None,
                Some(&context),
            )
        });
        let mut registered = false;
        for _ in 0..200 {
            registered = active_render_requests()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key("cancel-runtime-render");
            if registered {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(registered, "request render chậm phải đăng ký process lease");
        assert!(cancel_render_request("cancel-runtime-render"));
        assert!(cancelled_render.join().unwrap().is_err());

        let restart =
            render_display_with_policy(&file_path, 1, 0.5, 0, None, None, None, None, None)
                .expect("request kế tiếp phải restart worker");
        assert!(matches!(restart, WorkerAttempt::Completed(_)));
        assert!(matches!(
            bootstrap_with_policy(&file_path).expect("bootstrap sau restart"),
            WorkerAttempt::Completed(_)
        ));
        let WorkerAttempt::Completed(closed) =
            close_document_with_policy(&file_path).expect("worker manager close")
        else {
            panic!("mode worker phải close mọi process riêng");
        };
        assert!(closed);
        assert!(
            crate::PDFIUM_STATIC.get().is_none(),
            "đường worker thành công không được bind PDFium trong process parent"
        );
        shutdown_render_worker();
    }

    fn frame_prefix(header_len: u32, payload_len: u64) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(RENDER_WORKER_FRAME_PREFIX_BYTES);
        bytes.extend_from_slice(&RENDER_WORKER_MAGIC);
        bytes.extend_from_slice(&RENDER_WORKER_PROTOCOL_VERSION.to_le_bytes());
        bytes.extend_from_slice(&(RenderWorkerFrameKind::Request as u16).to_le_bytes());
        bytes.extend_from_slice(&1_u64.to_le_bytes());
        bytes.extend_from_slice(&header_len.to_le_bytes());
        bytes.extend_from_slice(&payload_len.to_le_bytes());
        bytes
    }

    fn hello_request() -> RenderWorkerRequest {
        RenderWorkerRequest::Hello(HelloRequest {
            request_id: "hello-1".to_string(),
            parent_pid: 1234,
            nonce: "nonce-1".to_string(),
            expected_app_version: env!("CARGO_PKG_VERSION").to_string(),
            expected_tile_cache_version: crate::TILE_RENDER_CACHE_VERSION.to_string(),
            expected_pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
        })
    }

    fn render_response() -> RenderWorkerResponse {
        RenderWorkerResponse::Render(RenderResponse {
            request_id: "render-9".to_string(),
            owner_id: "tab-a".to_string(),
            generation: 7,
            status: RenderResponseStatus::Ready,
            bitmap_width: Some(512),
            bitmap_height: Some(384),
            pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
            cache_tier: RenderCacheTier::Rendered,
            timing: RenderTiming {
                queue_ms: 2,
                wait_ms: 3,
                render_ms: Some(11),
                encode_ms: Some(4),
                cache_ms: Some(1),
                total_ms: 21,
            },
            soundness: RenderSoundness::DisplayPreview,
            unsupported_reason: None,
            fallback_font_sha256: None,
            substituted_fonts: Vec::new(),
            geometry_approximated: false,
            error: None,
        })
    }

    fn validation_request(path: &str, token: String) -> RenderRequest {
        RenderRequest {
            request_id: "validate-1".to_string(),
            owner_id: "viewer:tab-a:1".to_string(),
            session_owner_id: None,
            group_key: "page:1:viewport".to_string(),
            generation: 1,
            purpose: RenderPurpose::Interactive,
            priority: 0,
            document: RenderDocumentIdentity {
                path: path.to_string(),
                size_bytes: token.split(':').next().unwrap_or("0").to_string(),
                modified_nanos: "0".to_string(),
                created_nanos: "0".to_string(),
                token,
            },
            page: 1,
            rotation: 0,
            raster: RenderRaster::Scale {
                scale: 128.0,
                clip: Some(RenderClip {
                    x: 0,
                    y: 0,
                    width: 4000,
                    height: 4000,
                }),
            },
            color: RenderColor {
                pipeline: RenderColorPipeline::Display,
                profile_id: None,
                intent: None,
            },
            pipeline_identity: RENDER_WORKER_DISPLAY_PIPELINE_ID.to_string(),
            soundness: RenderSoundness::DisplayPreview,
        }
    }

    #[test]
    fn frame_hello_round_trip_khong_payload() {
        let expected = hello_request();
        let mut wire = Vec::new();
        write_frame(&mut wire, RenderWorkerFrameKind::Request, 1, &expected, &[]).unwrap();

        assert_eq!(&wire[0..4], &RENDER_WORKER_MAGIC);
        let actual: RenderWorkerFrame<RenderWorkerRequest> =
            read_frame(&mut Cursor::new(wire)).unwrap();
        assert_eq!(actual.kind, RenderWorkerFrameKind::Request);
        assert_eq!(actual.request_id, 1);
        assert_eq!(actual.header, expected);
        assert!(actual.payload.is_empty());
    }

    #[test]
    fn frame_cancel_mot_chieu_round_trip_khong_payload() {
        let expected = RenderWorkerRequest::Cancel(CancelRequest {
            request_id: "ppe-cancel-frame-1".to_string(),
        });
        let mut wire = Vec::new();
        write_frame(&mut wire, RenderWorkerFrameKind::Request, 7, &expected, &[]).unwrap();

        let actual: RenderWorkerFrame<RenderWorkerRequest> =
            read_frame(&mut Cursor::new(wire)).unwrap();
        assert_eq!(actual.request_id, 7);
        assert_eq!(actual.header, expected);
        assert!(actual.payload.is_empty());
    }

    #[test]
    fn frame_render_round_trip_giu_nguyen_png() {
        let expected = render_response();
        let png = b"\x89PNG\r\n\x1a\nnoi-dung".to_vec();
        let mut wire = Vec::new();
        write_frame(
            &mut wire,
            RenderWorkerFrameKind::Response,
            9,
            &expected,
            &png,
        )
        .unwrap();

        let actual: RenderWorkerFrame<RenderWorkerResponse> =
            read_frame(&mut Cursor::new(wire)).unwrap();
        assert_eq!(actual.kind, RenderWorkerFrameKind::Response);
        assert_eq!(actual.request_id, 9);
        assert_eq!(actual.header, expected);
        assert_eq!(actual.payload, png);
    }

    #[test]
    fn validation_giu_file_tam_khong_duoi_pdf_zoom_cao_va_clip_goc_trai() {
        let path = std::env::temp_dir().join(format!(
            "prynx_render_worker_validation_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, b"%PDF-1.7\n").unwrap();
        let path_string = path.to_string_lossy().into_owned();
        let identity = crate::pdf_file_identity(&path_string).unwrap();
        let token = crate::pdf_file_identity_token(identity);
        let request = validation_request(&path_string, token);

        let validated = validate_render_request(&request).unwrap();
        assert_eq!(
            std::fs::canonicalize(validated).unwrap(),
            std::fs::canonicalize(&path).unwrap()
        );

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn validation_tu_choi_file_cung_path_nhung_identity_da_doi() {
        let path = std::env::temp_dir().join(format!(
            "prynx_render_worker_identity_{}",
            std::process::id()
        ));
        std::fs::write(&path, b"%PDF-1.7\n").unwrap();
        let path_string = path.to_string_lossy().into_owned();
        let request = validation_request(&path_string, "1:2:3".to_string());

        let error = validate_render_request(&request).unwrap_err();
        assert!(error.contains("Identity PDF đã thay đổi"));

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn validation_nhan_ppe_accurate_dpi_nhung_van_khoa_profile_va_soundness() {
        let path = std::env::temp_dir().join(format!(
            "prynx_render_worker_accurate_validation_{}",
            std::process::id()
        ));
        std::fs::write(&path, b"%PDF-1.7\n").unwrap();
        let path_string = path.to_string_lossy().into_owned();
        let identity = crate::pdf_file_identity(&path_string).unwrap();
        let mut request =
            validation_request(&path_string, crate::pdf_file_identity_token(identity));
        request.raster = RenderRaster::Dpi {
            dpi: 96.0,
            clip: Some(RenderClip {
                x: 0,
                y: 0,
                width: 512,
                height: 384,
            }),
        };
        request.color = RenderColor {
            pipeline: RenderColorPipeline::Accurate,
            profile_id: Some("fogra39".to_string()),
            intent: Some("relative".to_string()),
        };
        request.session_owner_id = Some("viewer:tab-a:session".to_string());
        request.pipeline_identity = RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string();
        request.soundness = RenderSoundness::ColorVerified;

        assert_eq!(
            std::fs::canonicalize(validate_render_request(&request).unwrap()).unwrap(),
            std::fs::canonicalize(&path).unwrap()
        );

        request.session_owner_id = None;
        assert!(validate_render_request(&request)
            .unwrap_err()
            .contains("session_owner_id"));
        request.session_owner_id = Some("viewer:tab-a:session".to_string());
        request.color.profile_id = Some("../../profile".to_string());
        assert!(validate_render_request(&request)
            .unwrap_err()
            .contains("profile"));

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn worker_van_tra_png_ppe_khi_font_khong_nhung() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../backend/tests/preflight_fixtures/pdfs/04_font_not_embedded.pdf");
        let path = std::env::temp_dir().join(format!(
            "prynx_render_worker_font_substitute_{}_{}.pdf",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::copy(source, &path).unwrap();
        let path_string = path.to_string_lossy().into_owned();
        let identity = crate::pdf_file_identity(&path_string).unwrap();
        let mut request =
            validation_request(&path_string, crate::pdf_file_identity_token(identity));
        request.raster = RenderRaster::Dpi {
            dpi: 72.0,
            clip: None,
        };
        request.color = RenderColor {
            pipeline: RenderColorPipeline::Accurate,
            profile_id: Some("fogra39".to_string()),
            intent: Some("relative".to_string()),
        };
        request.session_owner_id = Some("viewer:test-font-substitute".to_string());
        request.purpose = RenderPurpose::Accurate;
        request.pipeline_identity = RENDER_WORKER_ACCURATE_PIPELINE_ID.to_string();
        request.soundness = RenderSoundness::ColorVerified;

        let (response, payload) = super::render_response(request, None);
        assert_eq!(response.status, RenderResponseStatus::Ready, "{response:?}");
        assert_eq!(response.unsupported_reason, None);
        assert_eq!(
            response.fallback_font_sha256.as_deref(),
            Some(PPE_FALLBACK_FONT_SHA256)
        );
        // FIX (audit 2026-09-20 §V20.3): Không nuốt cảnh báo hình học khi font không nhúng
        assert!(response.geometry_approximated);
        assert!(!response.substituted_fonts.is_empty());
        assert!(payload.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]));
        assert!(response.bitmap_width.is_some_and(|width| width > 0));
        assert!(response.bitmap_height.is_some_and(|height| height > 0));

        let canonical = std::fs::canonicalize(path).unwrap();
        close_accurate_sessions_for_path(&canonical.to_string_lossy());
        std::fs::remove_file(canonical).unwrap();
    }

    #[test]
    fn tu_choi_magic_khong_phai_pxrw() {
        let mut wire = Vec::new();
        write_frame(
            &mut wire,
            RenderWorkerFrameKind::Request,
            1,
            &hello_request(),
            &[],
        )
        .unwrap();
        wire[0..4].copy_from_slice(b"NOPE");

        let error = read_frame::<_, RenderWorkerRequest>(&mut Cursor::new(wire)).unwrap_err();
        assert!(matches!(
            error,
            RenderWorkerProtocolError::InvalidMagic(received) if received == *b"NOPE"
        ));
    }

    #[test]
    fn tu_choi_phien_ban_khong_ho_tro() {
        let mut wire = Vec::new();
        write_frame(
            &mut wire,
            RenderWorkerFrameKind::Request,
            1,
            &hello_request(),
            &[],
        )
        .unwrap();
        let unsupported = RENDER_WORKER_PROTOCOL_VERSION.saturating_add(1);
        wire[4..6].copy_from_slice(&unsupported.to_le_bytes());

        let error = read_frame::<_, RenderWorkerRequest>(&mut Cursor::new(wire)).unwrap_err();
        assert!(matches!(
            error,
            RenderWorkerProtocolError::UnsupportedVersion {
                received,
                supported: RENDER_WORKER_PROTOCOL_VERSION
            } if received == unsupported
        ));
    }

    #[test]
    fn tu_choi_loai_frame_khong_hop_le() {
        let mut wire = Vec::new();
        write_frame(
            &mut wire,
            RenderWorkerFrameKind::Request,
            1,
            &hello_request(),
            &[],
        )
        .unwrap();
        wire[6..8].copy_from_slice(&99_u16.to_le_bytes());

        let error = read_frame::<_, RenderWorkerRequest>(&mut Cursor::new(wire)).unwrap_err();
        assert!(matches!(
            error,
            RenderWorkerProtocolError::InvalidFrameKind(99)
        ));
    }

    #[test]
    fn tu_choi_header_rong_hoac_vuot_64_kib_truoc_khi_cap_phat() {
        for invalid_length in [0_u32, RENDER_WORKER_MAX_HEADER_BYTES as u32 + 1] {
            let wire = frame_prefix(invalid_length, 0);
            let error = read_frame::<_, RenderWorkerRequest>(&mut Cursor::new(wire)).unwrap_err();
            assert!(matches!(
                error,
                RenderWorkerProtocolError::HeaderLengthOutOfRange { length, .. }
                    if length == u64::from(invalid_length)
            ));
        }
    }

    #[test]
    fn tu_choi_payload_vuot_512_mib_truoc_khi_cap_phat() {
        let wire = frame_prefix(2, RENDER_WORKER_MAX_PAYLOAD_BYTES + 1);
        let error = read_frame::<_, serde_json::Value>(&mut Cursor::new(wire)).unwrap_err();
        assert!(matches!(
            error,
            RenderWorkerProtocolError::PayloadLengthOutOfRange { length, .. }
                if length == RENDER_WORKER_MAX_PAYLOAD_BYTES + 1
        ));
    }

    #[test]
    fn bao_loi_khi_tien_to_bi_cat() {
        let wire = frame_prefix(2, 0);
        let truncated = &wire[..RENDER_WORKER_FRAME_PREFIX_BYTES - 1];
        let error = read_frame::<_, serde_json::Value>(&mut Cursor::new(truncated)).unwrap_err();
        assert!(matches!(
            error,
            RenderWorkerProtocolError::Truncated {
                section: FrameSection::Prefix,
                expected: RENDER_WORKER_FRAME_PREFIX_BYTES,
                actual
            } if actual == RENDER_WORKER_FRAME_PREFIX_BYTES - 1
        ));
    }

    #[test]
    fn bao_loi_khi_header_bi_cat() {
        let mut wire = frame_prefix(5, 0);
        wire.extend_from_slice(b"{}\n");
        let error = read_frame::<_, serde_json::Value>(&mut Cursor::new(wire)).unwrap_err();
        assert!(matches!(
            error,
            RenderWorkerProtocolError::Truncated {
                section: FrameSection::Header,
                expected: 5,
                actual: 3
            }
        ));
    }

    #[test]
    fn bao_loi_khi_payload_bi_cat() {
        let mut wire = frame_prefix(2, 5);
        wire.extend_from_slice(b"{}");
        wire.extend_from_slice(b"abc");
        let error = read_frame::<_, serde_json::Value>(&mut Cursor::new(wire)).unwrap_err();
        assert!(matches!(
            error,
            RenderWorkerProtocolError::Truncated {
                section: FrameSection::Payload,
                expected: 5,
                actual: 3
            }
        ));
    }

    #[test]
    fn write_tu_choi_header_vuot_gioi_han_truoc_khi_ghi() {
        #[derive(Serialize)]
        struct OversizedHeader {
            value: String,
        }

        let header = OversizedHeader {
            value: "x".repeat(RENDER_WORKER_MAX_HEADER_BYTES),
        };
        let mut wire = Vec::new();
        let error =
            write_frame(&mut wire, RenderWorkerFrameKind::Request, 1, &header, &[]).unwrap_err();

        assert!(matches!(
            error,
            RenderWorkerProtocolError::HeaderLengthOutOfRange { .. }
        ));
        assert!(wire.is_empty());
    }
}
