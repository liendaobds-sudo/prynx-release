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
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use image::{ColorType, ImageEncoder};
use print_engine::color::RenderIntent;
use print_engine::content::RenderOptions;
use print_engine::oc::OptionalContentUsage;
use print_engine::page::{PageBox, RasterClip};
use print_engine::{CancelToken, PpeError, RenderSession, RenderWarnings};

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
const PPE_FALLBACK_FONT_SHA256: &str =
    "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954";

fn ppe_fallback_font() -> Arc<Vec<u8>> {
    static FONT: OnceLock<Arc<Vec<u8>>> = OnceLock::new();
    FONT.get_or_init(|| Arc::new(PPE_FALLBACK_FONT_BYTES.to_vec()))
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
        .filter_map(|(key, entry)| entry.owners.is_empty().then_some(key.clone()))
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
    let mut released = false;
    for entry in pool.entries.values_mut() {
        released |= entry.owners.release(owner_id);
    }
    close_ownerless_accurate_sessions(&mut pool);
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

pub fn viewer_shadow_render_enabled() -> bool {
    parse_shadow_render_enabled(std::env::var("PRYNX_VIEWER_SHADOW_RENDER").ok().as_deref())
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
                    .filter(|(_key, entry)| entry.owners.is_empty())
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
            .with_memory_budget_bytes(render_budget)
            .with_cancel_token(cancel_token.clone())
    };
    let render_result = if transient {
        // PERF (audit 2026-08-09 §L3C): máy ít RAM không đóng session của tab còn
        // sống để nhường chỗ. Tài liệu vượt pool chạy transient cache 0; chất lượng/DPI
        // giữ nguyên, chỉ lượt sau phải decode lại.
        drop(pool);
        let mut session =
            RenderSession::open_with_profile_paths(path, Some(&profile_path), None, intent)
                .map_err(|error| format!("Không mở được PPE RenderSession: {error}"))?
                .with_resource_cache_budget(0);
        let result = session.render_page_srgb_region_timed(
            request.page as usize,
            dpi,
            PageBox::Crop,
            options(),
            raster_clip,
        );
        session.close();
        result
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
        let result = entry.session.render_page_srgb_region_timed(
            request.page as usize,
            dpi,
            PageBox::Crop,
            options(),
            raster_clip,
        );
        if result.is_err()
            && pool
                .entries
                .get(&key)
                .is_some_and(|entry| !entry.session.is_valid())
        {
            if let Some(mut invalid) = pool.entries.remove(&key) {
                invalid.session.close();
            }
        }
        drop(pool);
        result
    };
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
    let render_ms =
        (timings.open + timings.parse + timings.raster + timings.color).as_millis() as u64;
    Ok(AccurateWorkerOutput {
        bytes,
        width: rendered.width,
        height: rendered.height,
        render_ms,
        encode_ms: encode_started.elapsed().as_millis() as u64,
        cache_ms: timings.resource.as_millis() as u64,
    })
}

fn render_response(
    request: RenderRequest,
    cancel_token: Option<&CancelToken>,
) -> (RenderResponse, Vec<u8>) {
    let base =
        |status, unsupported_reason, error, bitmap_width, bitmap_height, timing, cache_tier| {
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
                error,
            }
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
                    base(
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
    let render_result = crate::render_tile_png_in_process(
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
        Ok(bytes) => {
            let (width, height) = png_dimensions(&bytes);
            (
                base(
                    RenderResponseStatus::Ready,
                    None,
                    None,
                    width,
                    height,
                    RenderTiming {
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
    stdout: ChildStdout,
    next_request_id: u64,
    lane: WorkerLane,
}

enum ClientRequestError {
    Cancelled,
    Transport(String),
}

impl RenderWorkerClient {
    fn request(
        &mut self,
        request: &RenderWorkerRequest,
        cancellation: Option<&AtomicBool>,
    ) -> Result<RenderWorkerFrame<RenderWorkerResponse>, ClientRequestError> {
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
        self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
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
            return Err(ClientRequestError::Transport(format!(
                "Không gửi được request display worker: {error}"
            )));
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
        let response_result = read_frame::<_, RenderWorkerResponse>(&mut self.stdout);
        if let Some((logical_id, _, _)) = cancellable_request.as_ref() {
            unregister_active_render_request(logical_id, self.child_pid);
        }
        let response = response_result.map_err(|error| {
            ClientRequestError::Transport(format!(
                "Không đọc được response display worker: {error}"
            ))
        })?;
        if response.kind != RenderWorkerFrameKind::Response || response.request_id != request_id {
            return Err(ClientRequestError::Transport(
                "Display worker trả sai loại/request ID frame.".to_string(),
            ));
        }
        Ok(response)
    }

    fn terminate(&mut self) {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    }
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

fn unregister_active_render_request(request_id: &str, child_pid: u32) {
    let mut active = active_render_requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active
        .get(request_id)
        .is_some_and(|lease| lease.child_pid == child_pid)
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

static PREEMPTED_BACKGROUND_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
static BACKGROUND_PREEMPTION_COUNT: AtomicUsize = AtomicUsize::new(0);

fn preempted_background_pids() -> &'static Mutex<HashSet<u32>> {
    PREEMPTED_BACKGROUND_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn take_preempted_background_pid(child_pid: u32) -> bool {
    preempted_background_pids()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&child_pid)
}

fn preempt_background_on_interactive_lane() -> bool {
    let leases = {
        let mut active = active_render_requests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let request_ids = active
            .iter()
            .filter_map(|(request_id, lease)| {
                (lease.lane == WorkerLane::Interactive
                    && lease.purpose != RenderPurpose::Interactive)
                    .then_some(request_id.clone())
            })
            .collect::<Vec<_>>();
        request_ids
            .into_iter()
            .filter_map(|request_id| active.remove(&request_id))
            .collect::<Vec<_>>()
    };

    let mut killed_any = false;
    for lease in leases {
        // PERF (audit 2026-08-08 §RENDER.2): ghi lý do TRƯỚC kill. Nếu pipe đọc EOF
        // nhanh hơn thread preempt ghi marker, background sẽ bị hiểu nhầm là crash thường
        // và không retry. Kill thất bại thì rút marker lại.
        preempted_background_pids()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(lease.child_pid);
        let killed = lease
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .kill()
            .is_ok();
        if killed {
            killed_any = true;
            BACKGROUND_PREEMPTION_COUNT.fetch_add(1, Ordering::Relaxed);
        } else {
            preempted_background_pids()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&lease.child_pid);
        }
    }
    killed_any
}

#[derive(Default)]
struct SharedLaneState {
    active_purpose: Option<RenderPurpose>,
    interactive_waiters: usize,
}

struct SharedLanePriorityGate {
    state: Mutex<SharedLaneState>,
    wake: Condvar,
}

impl SharedLanePriorityGate {
    fn new() -> Self {
        Self {
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
                let killed = preempt_background_on_interactive_lane();
                state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                // Background đã lấy gate nhưng có thể chưa kịp đăng ký child lease.
                // Chờ rất ngắn để nó tiến tới điểm đăng ký hoặc tự nhả gate, tránh busy-spin.
                if !killed && state.active_purpose == Some(RenderPurpose::Background) {
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

struct RenderWorkerManager {
    interactive: Mutex<Option<RenderWorkerClient>>,
    backgrounds: Vec<Mutex<Option<RenderWorkerClient>>>,
    next_background: AtomicUsize,
    shared_lane_gate: SharedLanePriorityGate,
}

impl RenderWorkerManager {
    fn new(background_lane_count: usize) -> Self {
        Self {
            interactive: Mutex::new(None),
            backgrounds: (0..background_lane_count)
                .map(|_| Mutex::new(None))
                .collect(),
            next_background: AtomicUsize::new(0),
            shared_lane_gate: SharedLanePriorityGate::new(),
        }
    }
}

static RENDER_WORKER_MANAGER: OnceLock<RenderWorkerManager> = OnceLock::new();
static RENDER_WORKER_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn render_worker_manager() -> &'static RenderWorkerManager {
    RENDER_WORKER_MANAGER
        .get_or_init(|| RenderWorkerManager::new(configured_background_lane_count()))
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
        let cancel = RenderWorkerRequest::Cancel(CancelRequest {
            request_id: request_id.to_string(),
        });
        let sent = {
            let mut stdin = lease
                .stdin
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            write_frame(
                &mut *stdin,
                RenderWorkerFrameKind::Request,
                lease.wire_request_id,
                &cancel,
                &[],
            )
            .is_ok()
        };
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
        manager.shared_lane_gate.notify_cancelled();
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
    let child_pid = child.id();
    // [PROC-LIFECYCLE FIX 2026-08-28 §UP.7] Display worker giữ $INSTDIR\pdf-inspector.exe và
    // bin\pdfium.dll. Nếu app chết bẩn mà worker còn sống, NSIS không ghi đè được hai file
    // này khi cập nhật. Job Object bảo đảm OS dọn hộ, không phụ thuộc EOF stdin.
    crate::process_guard::adopt_child_process(child_pid);
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
        stdout,
        next_request_id: 1,
        lane,
    };
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
    let result = slot
        .as_mut()
        .expect("worker vừa được khởi tạo")
        .request(request, cancellation);
    match result {
        Ok(response) => {
            let _ = take_preempted_background_pid(child_pid);
            Ok(response)
        }
        Err(ClientRequestError::Cancelled) => Err(cancelled_transport_failure()),
        Err(ClientRequestError::Transport(message)) => {
            let preempted_background = take_preempted_background_pid(child_pid);
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
    let use_background_lane =
        purpose != RenderPurpose::Interactive && !manager.backgrounds.is_empty();

    if use_background_lane {
        let lane_count = manager.backgrounds.len();
        let start = manager.next_background.fetch_add(1, Ordering::Relaxed) % lane_count;
        for offset in 0..lane_count {
            let index = (start + offset) % lane_count;
            match manager.backgrounds[index].try_lock() {
                Ok(mut guard) => {
                    return dispatch_locked_worker(
                        &mut guard,
                        WorkerLane::Background(index),
                        request,
                        cancellation,
                    );
                }
                Err(TryLockError::Poisoned(poisoned)) => {
                    let mut guard = poisoned.into_inner();
                    return dispatch_locked_worker(
                        &mut guard,
                        WorkerLane::Background(index),
                        request,
                        cancellation,
                    );
                }
                Err(TryLockError::WouldBlock) => {}
            }
        }
        let mut guard = manager.backgrounds[start]
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        return dispatch_locked_worker(
            &mut guard,
            WorkerLane::Background(start),
            request,
            cancellation,
        );
    }

    // PERF (audit 2026-08-08 §RENDER.2): tier <8 GiB không spawn process nền riêng.
    // Gate này cho background mượn worker tương tác khi idle; interactive mới sẽ kill
    // đúng lease background, chiếm lane trước, rồi background retry sau khi lane rảnh.
    let _shared_lane = manager
        .backgrounds
        .is_empty()
        .then(|| manager.shared_lane_gate.acquire(purpose, cancellation))
        .transpose()
        .map_err(|message| WorkerTransportFailure {
            request_started: false,
            cancelled: true,
            preempted_background: false,
            message,
        })?;
    let mut guard = manager
        .interactive
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    dispatch_locked_worker(&mut guard, WorkerLane::Interactive, request, cancellation)
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
    let mut close_slot = |slot: &Mutex<Option<RenderWorkerClient>>| {
        let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(client) = guard.as_mut() else {
            return;
        };
        let child_pid = client.child_pid;
        match client.request(&request, None) {
            Ok(frame) => {
                let _ = take_preempted_background_pid(child_pid);
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
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    };
    close_slot(&manager.interactive);
    for slot in &manager.backgrounds {
        close_slot(slot);
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
    let mut release_slot = |slot: &Mutex<Option<RenderWorkerClient>>| {
        let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(client) = guard.as_mut() else {
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
                released = true;
            }
        }
    };
    release_slot(&manager.interactive);
    for slot in &manager.backgrounds {
        release_slot(slot);
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
        let _ = std::process::Command::new("taskkill")
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
    manager.shared_lane_gate.notify_cancelled();

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
    preempted_background_pids()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

#[cfg(test)]
mod tests {
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
        }
        for raw in ["1", "true", " YES ", "on"] {
            assert!(parse_shadow_render_enabled(Some(raw)), "{raw}");
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
    fn native_request_id_khong_trung_khi_goi_lien_tiep() {
        let first = native_request_id("metadata");
        let second = native_request_id("metadata");
        assert_ne!(first, second);
    }

    #[test]
    fn shared_lane_chi_cho_background_sau_khi_interactive_nha() {
        let gate = Arc::new(SharedLanePriorityGate::new());
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
