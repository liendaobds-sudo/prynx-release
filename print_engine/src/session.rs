//! Document session cho PPE.
//!
//! Session giữ các dữ liệu bất biến của một PDF qua nhiều lần render. Mục tiêu của
//! lớp này là cắt chi phí mở/duyệt cây trang ở đường zoom, nhưng không biến cache
//! thành nguồn sự thật: mọi pixel vẫn được dựng từ `lopdf::Document` hiện hành và
//! mọi request vẫn tính lại DPI, CTM, clip, alpha và blend.

use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use lopdf::{Document, ObjectId};

use crate::color::{ColorManager, RenderIntent};
use crate::content::RenderOptions;
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::image::sampler::SampledImage;
use crate::page::{
    build_page_descriptors, render_page_descriptor, PageBox, PageDescriptor, PageRender, RasterClip,
};

/// Phiên bản hợp đồng cache/session. Tăng khi thay đổi semantics pixel hoặc identity.
pub const SESSION_ENGINE_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "/session-1");

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FileStamp {
    canonical_path: PathBuf,
    size: u64,
    modified_ns: Option<u128>,
    created_ns: Option<u128>,
}

impl FileStamp {
    fn read(path: &Path) -> PpeResult<Self> {
        let canonical_path = fs::canonicalize(path).map_err(|error| {
            PpeError::OpenFailed(format!(
                "không chuẩn hóa được tệp '{}': {error}",
                path.display()
            ))
        })?;
        Self::read_canonical(&canonical_path)
    }

    /// Đường dẫn session/profile đã canonical hóa từ lúc mở; chỉ đọc metadata
    /// để đường zoom không lặp lại truy vấn chuẩn hóa filesystem.
    fn read_canonical(canonical_path: &Path) -> PpeResult<Self> {
        let metadata = fs::metadata(&canonical_path).map_err(|error| {
            PpeError::OpenFailed(format!(
                "không đọc được metadata tệp '{}': {error}",
                canonical_path.display()
            ))
        })?;
        Ok(Self {
            canonical_path: canonical_path.to_path_buf(),
            size: metadata.len(),
            modified_ns: system_time_ns(metadata.modified()),
            created_ns: system_time_ns(metadata.created()),
        })
    }
}

fn system_time_ns(value: std::io::Result<SystemTime>) -> Option<u128> {
    value
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// Danh tính tài liệu dùng cho cache và chống trả bitmap sau save-over.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DocumentIdentity {
    /// Đường dẫn canonical của file, hoặc nhãn tùy chọn cho tài liệu mở từ bộ nhớ.
    pub canonical_path: Option<PathBuf>,
    pub size: u64,
    pub modified_ns: Option<u128>,
    pub created_ns: Option<u128>,
    /// Hash nhẹ của bytes cho tài liệu in-memory; không dùng thay cho file stamp.
    pub content_hash: Option<u64>,
    pub engine_version: &'static str,
}

impl DocumentIdentity {
    fn from_stamp(stamp: &FileStamp) -> Self {
        Self {
            canonical_path: Some(stamp.canonical_path.clone()),
            size: stamp.size,
            modified_ns: stamp.modified_ns,
            created_ns: stamp.created_ns,
            content_hash: None,
            engine_version: SESSION_ENGINE_VERSION,
        }
    }

    fn from_bytes(label: Option<&Path>, bytes: &[u8]) -> Self {
        Self {
            canonical_path: label.map(Path::to_path_buf),
            size: bytes.len() as u64,
            modified_ns: None,
            created_ns: None,
            content_hash: Some(hash_bytes(bytes)),
            engine_version: SESSION_ENGINE_VERSION,
        }
    }
}

/// Danh tính profile màu ở mức session.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProfileFileIdentity {
    pub canonical_path: PathBuf,
    pub size: u64,
    pub modified_ns: Option<u128>,
    pub created_ns: Option<u128>,
    /// Fingerprint nội dung khóa cache màu, không chỉ dựa vào tên/metadata file.
    pub content_hash: u64,
}

impl ProfileFileIdentity {
    fn read(path: &Path) -> PpeResult<Self> {
        let before = FileStamp::read(path)?;
        let bytes = fs::read(&before.canonical_path).map_err(|error| {
            PpeError::OpenFailed(format!(
                "không đọc được profile màu '{}': {error}",
                before.canonical_path.display()
            ))
        })?;
        let after = FileStamp::read_canonical(&before.canonical_path)?;
        if before != after {
            return Err(PpeError::OpenFailed(
                "profile màu đã thay đổi trong lúc đọc; hãy thử lại".into(),
            ));
        }
        Ok(Self {
            canonical_path: after.canonical_path,
            size: after.size,
            modified_ns: after.modified_ns,
            created_ns: after.created_ns,
            content_hash: hash_bytes(&bytes),
        })
    }

    fn matches_stamp(&self, stamp: &FileStamp) -> bool {
        self.canonical_path == stamp.canonical_path
            && self.size == stamp.size
            && self.modified_ns == stamp.modified_ns
            && self.created_ns == stamp.created_ns
    }
}

/// Danh tính đầy đủ của pipeline màu giữ trong session.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProfileIdentity {
    pub cmyk_profile: Option<ProfileFileIdentity>,
    pub rgb_profile: Option<ProfileFileIdentity>,
    pub intent: u8,
}

impl ProfileIdentity {
    fn from_paths(
        cmyk: Option<&Path>,
        rgb: Option<&Path>,
        intent: RenderIntent,
    ) -> PpeResult<Self> {
        Ok(Self {
            cmyk_profile: cmyk.map(ProfileFileIdentity::read).transpose()?,
            rgb_profile: rgb.map(ProfileFileIdentity::read).transpose()?,
            intent: render_intent_code(intent),
        })
    }
}

fn render_intent_code(intent: RenderIntent) -> u8 {
    match intent {
        RenderIntent::Perceptual => 0,
        RenderIntent::RelativeColorimetric => 1,
        RenderIntent::Saturation => 2,
        RenderIntent::AbsoluteColorimetric => 3,
    }
}

/// Danh tính đầy đủ của một session.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionIdentity {
    pub document: DocumentIdentity,
    pub profile: Option<ProfileIdentity>,
    /// PPE hiện đọc optional content theo cấu hình in.
    pub ocg_mode: &'static str,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResourceCacheStats {
    pub image_hits: u64,
    pub image_misses: u64,
    pub image_evictions: u64,
    pub page_hits: u64,
    pub page_misses: u64,
    pub bytes: usize,
    pub budget_bytes: usize,
}

/// Timing mở session, tách theo đúng biên mà core trực tiếp đo được.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionOpenTimings {
    pub total: Duration,
    /// Chuẩn hóa/stat đường dẫn và mở file descriptor; không gồm parse PDF.
    pub open: Duration,
    /// Đọc + parse cấu trúc PDF bằng lopdf.
    pub parse: Duration,
    /// Dựng page descriptor/resource scope dùng lại qua các lượt render.
    pub resource: Duration,
    /// Đọc profile, kiểm fingerprint và dựng ColorManager.
    pub color: Duration,
}

/// Timing một lượt render qua session.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionRenderTimings {
    /// Mở lại file descriptor/kiểm stamp khi save-over; 0 ở lượt warm thường.
    pub open: Duration,
    /// Đọc + parse lại PDF khi save-over; 0 ở lượt warm thường.
    pub parse: Duration,
    /// Refresh identity và lấy page descriptor/cache owner.
    pub resource: Duration,
    /// Raster content; khi cache miss, chi phí decode resource nằm trong pha này.
    pub raster: Duration,
    /// Quy buffer mực sang sRGB qua ColorManager của session.
    pub color: Duration,
}

impl SessionRenderTimings {
    fn add_assign(&mut self, other: Self) {
        self.open += other.open;
        self.parse += other.parse;
        self.resource += other.resource;
        self.raster += other.raster;
        self.color += other.color;
    }
}

/// Kết quả sRGB của đường soft-proof dùng ColorManager được giữ trong session.
pub struct SrgbPageRender {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
    pub rotate: i32,
    pub warnings: RenderWarnings,
}

struct CachedImage {
    image: Arc<SampledImage>,
    warnings: RenderWarnings,
    bytes: usize,
    last_used: u64,
}

/// Ước lượng bảo thủ cho Arc, key và bucket HashMap của mỗi entry.
const RESOURCE_CACHE_ENTRY_OVERHEAD_BYTES: usize = 64;

/// Cache resource sống cùng document session.
///
/// Cache này chỉ nhận ảnh mà Renderer đã chứng minh có colorspace tự chứa. Khi
/// ngân sách không đủ, entry mới bị bỏ qua; đường render vẫn giải mã lại và giữ
/// nguyên độ chính xác. Dung lượng gồm mẫu ảnh và overhead bảo thủ của entry;
/// eviction theo LRU. `Mutex` chỉ khóa thao tác map ngắn, không khóa lúc decode.
pub struct ResourceCache {
    images: HashMap<ObjectId, CachedImage>,
    used_bytes: usize,
    budget_bytes: usize,
    image_hits: u64,
    image_misses: u64,
    image_evictions: u64,
    access_clock: u64,
}

impl ResourceCache {
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            images: HashMap::new(),
            used_bytes: 0,
            budget_bytes,
            image_hits: 0,
            image_misses: 0,
            image_evictions: 0,
            access_clock: 0,
        }
    }

    pub fn budget_bytes(&self) -> usize {
        self.budget_bytes
    }

    pub fn set_budget_bytes(&mut self, budget_bytes: usize) {
        self.budget_bytes = budget_bytes;
        if budget_bytes == 0 {
            self.images.clear();
            self.used_bytes = 0;
            return;
        }
        self.evict_to_budget();
    }

    pub fn clear(&mut self) {
        self.images.clear();
        self.used_bytes = 0;
        self.image_hits = 0;
        self.image_misses = 0;
        self.image_evictions = 0;
        self.access_clock = 0;
    }

    pub(crate) fn get_image(
        &mut self,
        key: ObjectId,
    ) -> Option<(Arc<SampledImage>, RenderWarnings)> {
        let last_used = self.next_access();
        let Some(entry) = self.images.get_mut(&key) else {
            self.image_misses = self.image_misses.saturating_add(1);
            return None;
        };
        self.image_hits = self.image_hits.saturating_add(1);
        entry.last_used = last_used;
        Some((Arc::clone(&entry.image), entry.warnings.clone()))
    }

    pub(crate) fn insert_image(
        &mut self,
        key: ObjectId,
        image: Arc<SampledImage>,
        warnings: RenderWarnings,
    ) -> bool {
        if self.budget_bytes == 0 || self.images.contains_key(&key) {
            return false;
        }
        let bytes = image
            .memory_bytes()
            .saturating_add(render_warnings_memory_bytes(&warnings))
            .saturating_add(RESOURCE_CACHE_ENTRY_OVERHEAD_BYTES);
        if bytes > self.budget_bytes {
            return false;
        }
        self.evict_until_fits(bytes);
        if self.used_bytes.saturating_add(bytes) > self.budget_bytes {
            return false;
        }
        self.used_bytes = self.used_bytes.saturating_add(bytes);
        let last_used = self.next_access();
        self.images.insert(
            key,
            CachedImage {
                image,
                warnings,
                bytes,
                last_used,
            },
        );
        true
    }

    pub(crate) fn stats(&self, page_hits: u64, page_misses: u64) -> ResourceCacheStats {
        ResourceCacheStats {
            image_hits: self.image_hits,
            image_misses: self.image_misses,
            image_evictions: self.image_evictions,
            page_hits,
            page_misses,
            bytes: self.used_bytes,
            budget_bytes: self.budget_bytes,
        }
    }

    fn evict_until_fits(&mut self, required: usize) {
        while self.used_bytes.saturating_add(required) > self.budget_bytes {
            if !self.evict_lru() {
                break;
            }
        }
    }

    fn evict_to_budget(&mut self) {
        while self.used_bytes > self.budget_bytes {
            if !self.evict_lru() {
                break;
            }
        }
    }

    fn evict_lru(&mut self) -> bool {
        let Some(key) = self
            .images
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| *key)
        else {
            return false;
        };
        if let Some(entry) = self.images.remove(&key) {
            self.used_bytes = self.used_bytes.saturating_sub(entry.bytes);
            self.image_evictions = self.image_evictions.saturating_add(1);
            return true;
        }
        false
    }

    fn next_access(&mut self) -> u64 {
        self.access_clock = self.access_clock.saturating_add(1);
        self.access_clock
    }
}

fn render_warnings_memory_bytes(warnings: &RenderWarnings) -> usize {
    let string_bytes = warnings
        .skipped_ops
        .iter()
        .map(|(name, _)| name.capacity())
        .chain(
            warnings
                .approximated_colorspaces
                .iter()
                .map(String::capacity),
        )
        .chain(warnings.substituted_fonts.iter().map(String::capacity))
        .chain(warnings.colorspaces_used.iter().map(String::capacity))
        .fold(0usize, usize::saturating_add);
    std::mem::size_of::<RenderWarnings>()
        .saturating_add(
            warnings
                .skipped_ops
                .capacity()
                .saturating_mul(std::mem::size_of::<(String, u32)>()),
        )
        .saturating_add(
            warnings
                .approximated_colorspaces
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        )
        .saturating_add(
            warnings
                .substituted_fonts
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        )
        .saturating_add(
            warnings
                .colorspaces_used
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        )
        .saturating_add(string_bytes)
}

pub(crate) type SharedResourceCache = Arc<Mutex<ResourceCache>>;

#[derive(Clone)]
struct ProfileConfig {
    cmyk_profile: PathBuf,
    rgb_profile: Option<PathBuf>,
    intent: RenderIntent,
}

impl ProfileConfig {
    /// Mở pipeline màu giữa hai lần đọc identity để không ghép manager cũ với
    /// identity mới nếu profile bị thay đúng lúc tạo/làm mới session.
    fn load_stable(&self) -> PpeResult<(ProfileIdentity, ColorManager)> {
        let before = ProfileIdentity::from_paths(
            Some(&self.cmyk_profile),
            self.rgb_profile.as_deref(),
            self.intent,
        )?;
        let manager = ColorManager::from_profiles(
            &self.cmyk_profile,
            self.rgb_profile.as_deref(),
            self.intent,
        )?;
        let after = ProfileIdentity::from_paths(
            Some(&self.cmyk_profile),
            self.rgb_profile.as_deref(),
            self.intent,
        )?;
        if before != after {
            return Err(PpeError::OpenFailed(
                "profile màu đã thay đổi trong lúc tạo RenderSession; hãy thử lại".into(),
            ));
        }
        Ok((after, manager))
    }

    /// Kiểm metadata ở đường render; fingerprint nội dung chỉ được đọc lại khi
    /// refresh để không băm toàn bộ ICC ở mỗi frame zoom.
    fn is_stale(&self, identity: &ProfileIdentity) -> bool {
        if identity.intent != render_intent_code(self.intent) {
            return true;
        }
        let cmyk_matches = identity.cmyk_profile.as_ref().is_some_and(|expected| {
            FileStamp::read_canonical(&self.cmyk_profile)
                .is_ok_and(|stamp| expected.matches_stamp(&stamp))
        });
        if !cmyk_matches {
            return true;
        }
        match (&self.rgb_profile, &identity.rgb_profile) {
            (None, None) => false,
            (Some(path), Some(expected)) => FileStamp::read_canonical(path)
                .map(|stamp| !expected.matches_stamp(&stamp))
                .unwrap_or(true),
            _ => true,
        }
    }
}

/// Session sở hữu document và cache resource cho nhiều lần render tuần tự.
pub struct RenderSession {
    document: Option<Document>,
    source_path: Option<PathBuf>,
    identity: SessionIdentity,
    pages: Vec<Arc<PageDescriptor>>,
    resource_cache: SharedResourceCache,
    page_hits: u64,
    page_misses: u64,
    profile_config: Option<ProfileConfig>,
    color_manager: Option<ColorManager>,
    generation: u64,
    valid: bool,
}

impl RenderSession {
    /// Mở PDF từ đường dẫn và chuẩn bị descriptor trang một lần.
    pub fn open(path: impl AsRef<Path>) -> PpeResult<Self> {
        Self::open_with_profile_paths(path, None, None, RenderIntent::default())
    }

    /// Mở PDF và giữ ColorManager trong session nếu có profile CMYK.
    pub fn open_with_profile_paths(
        path: impl AsRef<Path>,
        cmyk_profile: Option<&Path>,
        rgb_profile: Option<&Path>,
        intent: RenderIntent,
    ) -> PpeResult<Self> {
        Self::open_with_profile_paths_timed(path, cmyk_profile, rgb_profile, intent)
            .map(|(session, _timings)| session)
    }

    /// Mở session và trả timing từng pha cho coordinator/backend.
    ///
    /// PERF (audit 2026-08-09 §L2B): đo tại đúng biên core thay vì để Python
    /// suy diễn một số tổng. `parse` vẫn gồm thời gian đọc qua `BufReader`, vì lopdf
    /// parse theo luồng; tách giả phần I/O khỏi parser sẽ cho số không trung thực.
    pub fn open_with_profile_paths_timed(
        path: impl AsRef<Path>,
        cmyk_profile: Option<&Path>,
        rgb_profile: Option<&Path>,
        intent: RenderIntent,
    ) -> PpeResult<(Self, SessionOpenTimings)> {
        let total_started = Instant::now();
        let path = path.as_ref();
        let open_started = Instant::now();
        let before = FileStamp::read(path)?;
        let file = fs::File::open(&before.canonical_path).map_err(|error| {
            PpeError::OpenFailed(format!("không mở được PDF '{}': {error}", path.display()))
        })?;
        let mut open_elapsed = open_started.elapsed();

        let parse_started = Instant::now();
        let document = Document::load_from(BufReader::new(file)).map_err(|error| {
            PpeError::OpenFailed(format!("không mở được PDF '{}': {error}", path.display()))
        })?;
        let parse_elapsed = parse_started.elapsed();

        let stamp_started = Instant::now();
        let stamp = FileStamp::read_canonical(&before.canonical_path)?;
        open_elapsed += stamp_started.elapsed();
        if before != stamp {
            return Err(PpeError::OpenFailed(
                "PDF đã thay đổi trong lúc tạo RenderSession; hãy thử lại".into(),
            ));
        }

        let color_started = Instant::now();
        let (profile, profile_config, color_manager) = match cmyk_profile {
            Some(_) => {
                let identity = ProfileIdentity::from_paths(cmyk_profile, rgb_profile, intent)?;
                let config = ProfileConfig {
                    cmyk_profile: identity
                        .cmyk_profile
                        .as_ref()
                        .expect("cmyk_profile có giá trị phải tạo được identity")
                        .canonical_path
                        .clone(),
                    rgb_profile: identity
                        .rgb_profile
                        .as_ref()
                        .map(|profile| profile.canonical_path.clone()),
                    intent,
                };
                let (identity, manager) = config.load_stable()?;
                (Some(identity), Some(config), Some(manager))
            }
            None => (None, None, None),
        };
        let color_elapsed = color_started.elapsed();

        let resource_started = Instant::now();
        let pages = build_page_descriptors(&document)?;
        let resource_elapsed = resource_started.elapsed();
        let session = Self::from_document_parts(
            document,
            Some(stamp.canonical_path.clone()),
            DocumentIdentity::from_stamp(&stamp),
            profile,
            profile_config,
            color_manager,
            pages,
        );
        Ok((
            session,
            SessionOpenTimings {
                total: total_started.elapsed(),
                open: open_elapsed,
                parse: parse_elapsed,
                resource: resource_elapsed,
                color: color_elapsed,
            },
        ))
    }

    /// Mở PDF từ bytes. `label` chỉ dùng để hiển thị/nhận diện, không theo dõi save-over.
    pub fn open_mem(bytes: &[u8], label: Option<&Path>) -> PpeResult<Self> {
        let document = Document::load_mem(bytes).map_err(|error| {
            PpeError::OpenFailed(format!("không mở được PDF trong bộ nhớ: {error}"))
        })?;
        let label = label.map(Path::to_path_buf);
        Self::from_document(
            document,
            None,
            DocumentIdentity::from_bytes(label.as_deref(), bytes),
            None,
            None,
            None,
        )
    }

    fn from_document(
        document: Document,
        source_path: Option<PathBuf>,
        document_identity: DocumentIdentity,
        profile: Option<ProfileIdentity>,
        profile_config: Option<ProfileConfig>,
        color_manager: Option<ColorManager>,
    ) -> PpeResult<Self> {
        let pages = build_page_descriptors(&document)?;
        Ok(Self::from_document_parts(
            document,
            source_path,
            document_identity,
            profile,
            profile_config,
            color_manager,
            pages,
        ))
    }

    fn from_document_parts(
        document: Document,
        source_path: Option<PathBuf>,
        document_identity: DocumentIdentity,
        profile: Option<ProfileIdentity>,
        profile_config: Option<ProfileConfig>,
        color_manager: Option<ColorManager>,
        pages: Vec<Arc<PageDescriptor>>,
    ) -> Self {
        Self {
            document: Some(document),
            source_path,
            identity: SessionIdentity {
                document: document_identity,
                profile,
                ocg_mode: "print",
            },
            pages,
            resource_cache: Arc::new(Mutex::new(ResourceCache::new(0))),
            page_hits: 0,
            page_misses: 0,
            profile_config,
            color_manager,
            generation: 1,
            valid: true,
        }
    }

    /// Đặt ngân sách cache resource; `0` tắt cache nhưng không tắt render.
    pub fn with_resource_cache_budget(mut self, budget_bytes: usize) -> Self {
        self.set_resource_cache_budget(budget_bytes);
        self
    }

    pub fn set_resource_cache_budget(&mut self, budget_bytes: usize) {
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.set_budget_bytes(budget_bytes);
        }
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn is_valid(&self) -> bool {
        self.valid && self.document.is_some()
    }

    pub fn identity(&self) -> &SessionIdentity {
        &self.identity
    }

    pub fn resource_cache_stats(&self) -> ResourceCacheStats {
        self.resource_cache
            .lock()
            .map(|cache| cache.stats(self.page_hits, self.page_misses))
            .unwrap_or_default()
    }

    /// Trả `true` nếu file nguồn đã đổi metadata từ lúc mở session.
    pub fn is_stale(&self) -> bool {
        let Some(path) = &self.source_path else {
            return false;
        };
        let Ok(stamp) = FileStamp::read_canonical(path) else {
            return true;
        };
        if DocumentIdentity::from_stamp(&stamp) != self.identity.document {
            return true;
        }
        let Some(profile) = &self.profile_config else {
            return false;
        };
        self.identity
            .profile
            .as_ref()
            .map_or(true, |identity| profile.is_stale(identity))
    }

    /// Nạp lại file khi save-over. Nếu file mới lỗi, session bị vô hiệu hóa fail-closed.
    pub fn refresh_if_changed(&mut self) -> PpeResult<bool> {
        self.refresh_if_changed_timed()
            .map(|(changed, _timings)| changed)
    }

    fn refresh_if_changed_timed(&mut self) -> PpeResult<(bool, SessionRenderTimings)> {
        let mut timings = SessionRenderTimings::default();
        let resource_started = Instant::now();
        if !self.is_valid() {
            return Err(PpeError::Unsupported(
                "RenderSession đã bị vô hiệu hóa".into(),
            ));
        }
        if !self.is_stale() {
            timings.resource += resource_started.elapsed();
            return Ok((false, timings));
        }
        let Some(path) = self.source_path.clone() else {
            timings.resource += resource_started.elapsed();
            return Ok((false, timings));
        };
        timings.resource += resource_started.elapsed();

        let open_started = Instant::now();
        let before = FileStamp::read_canonical(&path)?;
        let file = fs::File::open(&before.canonical_path).map_err(|error| {
            PpeError::OpenFailed(format!(
                "không mở lại được PDF '{}': {error}",
                path.display()
            ))
        })?;
        timings.open += open_started.elapsed();

        let parse_started = Instant::now();
        let document = Document::load_from(BufReader::new(file)).map_err(|error| {
            PpeError::OpenFailed(format!(
                "không mở lại được PDF '{}': {error}",
                path.display()
            ))
        })?;
        timings.parse += parse_started.elapsed();

        let stamp_started = Instant::now();
        let stamp = FileStamp::read_canonical(&before.canonical_path)?;
        timings.open += stamp_started.elapsed();
        if before != stamp {
            return Err(PpeError::OpenFailed(
                "PDF đã thay đổi trong lúc làm mới RenderSession; hãy thử lại".into(),
            ));
        }
        let pages_started = Instant::now();
        let pages = build_page_descriptors(&document)?;
        timings.resource += pages_started.elapsed();
        let profile_config = self.profile_config.clone();
        let color_started = Instant::now();
        let (profile_identity, color_manager) = match &profile_config {
            Some(profile) => {
                let (identity, manager) = profile.load_stable()?;
                (Some(identity), Some(manager))
            }
            None => (None, None),
        };
        timings.color += color_started.elapsed();

        // Dựng snapshot mới xong hoàn toàn rồi mới thay owner hiện hành. Nếu bắt
        // đúng lúc ứng dụng khác đang ghi dở, request này fail-closed nhưng session
        // cũ vẫn đủ trạng thái để request sau thử refresh lại; không chết vĩnh viễn.
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.clear();
        }
        self.page_hits = 0;
        self.page_misses = 0;
        self.document = Some(document);
        self.pages = pages;
        self.identity.document = DocumentIdentity::from_stamp(&stamp);
        self.identity.profile = profile_identity;
        self.color_manager = color_manager;
        self.valid = true;
        self.generation = self.generation.saturating_add(1);
        Ok((true, timings))
    }

    /// Đóng session ngay lập tức và thả Document/cache.
    pub fn close(&mut self) {
        self.invalidate();
    }

    /// Vô hiệu hóa owner hiện tại; bitmap/resource cũ không còn được dùng lại.
    pub fn invalidate(&mut self) {
        self.document.take();
        self.color_manager.take();
        self.pages.clear();
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.clear();
        }
        self.page_hits = 0;
        self.page_misses = 0;
        self.valid = false;
        self.generation = self.generation.saturating_add(1);
    }

    /// Chuyển session thành owner dùng chung; Mutex serialize đúng một renderer.
    pub fn into_shared(self) -> SharedRenderSession {
        Arc::new(Mutex::new(self))
    }

    pub fn render_page(
        &mut self,
        page_number: usize,
        dpi: f32,
        which_box: PageBox,
        opts: RenderOptions,
    ) -> PpeResult<PageRender> {
        self.render_page_region(page_number, dpi, which_box, opts, None)
    }

    pub fn render_page_region(
        &mut self,
        page_number: usize,
        dpi: f32,
        which_box: PageBox,
        opts: RenderOptions,
        clip: Option<RasterClip>,
    ) -> PpeResult<PageRender> {
        self.render_page_region_timed(page_number, dpi, which_box, opts, clip)
            .map(|(rendered, _timings)| rendered)
    }

    /// Render một vùng và đo riêng phần điều phối resource với raster.
    pub fn render_page_region_timed(
        &mut self,
        page_number: usize,
        dpi: f32,
        which_box: PageBox,
        opts: RenderOptions,
        clip: Option<RasterClip>,
    ) -> PpeResult<(PageRender, SessionRenderTimings)> {
        self.render_page_region_timed_internal(page_number, dpi, which_box, opts, clip, true)
    }

    fn render_page_region_timed_internal(
        &mut self,
        page_number: usize,
        dpi: f32,
        which_box: PageBox,
        opts: RenderOptions,
        clip: Option<RasterClip>,
        verify_after_raster: bool,
    ) -> PpeResult<(PageRender, SessionRenderTimings)> {
        let mut timings = SessionRenderTimings::default();
        for attempt in 0..2 {
            let resource_started = Instant::now();
            if !self.is_valid() {
                return Err(PpeError::Unsupported(
                    "RenderSession đã bị vô hiệu hóa".into(),
                ));
            }
            timings.resource += resource_started.elapsed();
            let (_refreshed, refresh_timings) = self.refresh_if_changed_timed()?;
            timings.add_assign(refresh_timings);
            let resource_started = Instant::now();
            let descriptor = match page_number
                .checked_sub(1)
                .and_then(|index| self.pages.get(index))
                .filter(|descriptor| descriptor.number == page_number)
                .cloned()
            {
                Some(descriptor) => descriptor,
                None => {
                    self.page_misses = self.page_misses.saturating_add(1);
                    return Err(PpeError::PageOutOfRange {
                        requested: page_number,
                        total: self.pages.len(),
                    });
                }
            };
            self.page_hits = self.page_hits.saturating_add(1);
            let document = self
                .document
                .as_ref()
                .expect("session hợp lệ phải có document");
            let color = self.color_manager.as_ref();
            timings.resource += resource_started.elapsed();

            let raster_started = Instant::now();
            let rendered = render_page_descriptor(
                document,
                &descriptor,
                dpi,
                which_box,
                opts.clone(),
                color,
                clip,
                Some(Arc::clone(&self.resource_cache)),
            )?;
            timings.raster += raster_started.elapsed();

            // Đường sRGB kiểm stale sau color conversion nên không stat PDF/ICC
            // thêm một lần ở đây. Public ink-buffer API vẫn giữ post-check riêng.
            if !verify_after_raster {
                return Ok((rendered, timings));
            }

            let verify_started = Instant::now();
            if !self.is_stale() {
                timings.resource += verify_started.elapsed();
                return Ok((rendered, timings));
            }
            timings.resource += verify_started.elapsed();
            if attempt == 1 {
                self.invalidate();
                return Err(PpeError::OpenFailed(
                    "PDF/profile tiếp tục thay đổi trong lúc render; đã hủy bitmap cũ".into(),
                ));
            }
        }
        unreachable!("vòng render chỉ kết thúc bằng kết quả hoặc lỗi")
    }

    /// Render soft-proof sRGB bằng chính ColorManager được khóa trong session.
    ///
    /// Phép kiểm stale được lặp lại sau color conversion để profile/PDF bị
    /// save-over đúng cửa sổ này không làm lọt một frame cũ ra backend.
    pub fn render_page_srgb_region_timed(
        &mut self,
        page_number: usize,
        dpi: f32,
        which_box: PageBox,
        opts: RenderOptions,
        clip: Option<RasterClip>,
    ) -> PpeResult<(SrgbPageRender, SessionRenderTimings)> {
        let mut total_timings = SessionRenderTimings::default();
        for attempt in 0..2 {
            opts.check_cancelled()?;
            let (rendered, render_timings) = self.render_page_region_timed_internal(
                page_number,
                dpi,
                which_box,
                opts.clone(),
                clip,
                false,
            )?;
            total_timings.add_assign(render_timings);
            opts.check_cancelled()?;

            let color_started = Instant::now();
            let manager = self.color_manager.as_ref().ok_or_else(|| {
                PpeError::Unsupported("soft-proof session cần profile CMYK và ColorManager".into())
            })?;
            let rgb = rendered
                .buffer
                .to_srgb_with_cancel_and_settings(
                    manager,
                    opts.cancellation_token(),
                    opts.softproof_settings(),
                )?
                .ok_or_else(|| PpeError::Unsupported("không quy được mực sang sRGB".into()))?;
            total_timings.color += color_started.elapsed();
            opts.check_cancelled()?;

            let verify_started = Instant::now();
            if !self.is_stale() {
                total_timings.resource += verify_started.elapsed();
                return Ok((
                    SrgbPageRender {
                        width: rendered.buffer.width(),
                        height: rendered.buffer.height(),
                        rgb,
                        rotate: rendered.rotate,
                        warnings: rendered.warnings,
                    },
                    total_timings,
                ));
            }
            total_timings.resource += verify_started.elapsed();
            if attempt == 1 {
                self.invalidate();
                return Err(PpeError::OpenFailed(
                    "PDF/profile tiếp tục thay đổi trong lúc quy màu; đã hủy bitmap cũ".into(),
                ));
            }
        }
        unreachable!("vòng soft-proof chỉ kết thúc bằng kết quả hoặc lỗi")
    }
}

pub type SharedRenderSession = Arc<Mutex<RenderSession>>;
