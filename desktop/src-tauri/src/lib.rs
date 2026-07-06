use tauri::{Manager, Emitter};
use tauri::http::{self};

// Add state struct for PDFium
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::collections::HashMap;
use pdfium_render::prelude::*;
use tauri::ipc::Response;

// `creation_flags` (ẩn cửa sổ console) đến từ trait CommandExt — chỉ cần ở các block
// bảo mật release-only trên Windows. Guard theo cfg để debug không cảnh báo unused.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
use std::os::windows::process::CommandExt;

mod pdf_engine;
mod security;


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

fn tile_cache_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("prynx_tile_cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn tile_disk_path(cache_key: &str) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cache_key.hash(&mut h);
    tile_cache_dir().join(format!("{:016x}.jpg", h.finish()))
}

// Giữ tối đa `max_files` tile mới nhất trên đĩa; xoá cũ nhất khi vượt.
fn prune_tile_cache_dir(max_files: usize) {
    let dir = tile_cache_dir();
    let mut entries: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(meta) = e.metadata() {
                entries.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), e.path()));
            }
        }
    }
    if entries.len() > max_files {
        entries.sort_by_key(|(t, _)| *t);
        let remove_n = entries.len() - max_files;
        for (_, p) in entries.into_iter().take(remove_n) {
            let _ = std::fs::remove_file(p);
        }
    }
}

struct DocHandle {
    doc: PdfDocument<'static>,
    lock: Mutex<()>,
    // Cache page ĐÃ MỞ (LRU) để pdfium TÁI DÙNG ảnh đã giải nén giữa các lần render
    // (re-render/zoom/thumbnail rớt từ ~600ms → ~120ms cho trang nhiều ảnh nặng).
    pages: Mutex<PageLru>,
}

// LRU các PdfPage đang mở. Giữ ít (mặc định 4) vì mỗi page giữ ảnh đã giải nén tốn RAM.
struct PageLru {
    map: HashMap<u16, PdfPage<'static>>,
    order: std::collections::VecDeque<u16>,
    max: usize,
}
impl PageLru {
    fn new(max: usize) -> Self {
        Self { map: HashMap::new(), order: std::collections::VecDeque::new(), max }
    }
}

struct CachedDocument {
    pool: Vec<OnceLock<DocHandle>>,
    next: AtomicUsize, // Round-robin index
}
unsafe impl Send for CachedDocument {}
unsafe impl Sync for CachedDocument {}
unsafe impl Send for DocHandle {}
unsafe impl Sync for DocHandle {}

struct SyncPdfium(&'static Pdfium);
unsafe impl Send for SyncPdfium {}
unsafe impl Sync for SyncPdfium {}

static PDFIUM_STATIC: OnceLock<SyncPdfium> = OnceLock::new();
static DOC_CACHE: OnceLock<Mutex<HashMap<String, Arc<CachedDocument>>>> = OnceLock::new();

/// Bind thư viện pdfium MỘT LẦN (OnceLock). Tách hàm để vừa dùng trong các lệnh
/// Tìm & bind pdfium.dll. Thử các đường dẫn TUYỆT ĐỐI cạnh executable trước
/// (release: working-dir là thư mục cài đặt, không phải thư mục exe → "./bin/" sai),
/// sau đó mới tới đường dẫn tương đối (dev) và system library.
fn bind_pdfium() -> Result<Box<dyn PdfiumLibraryBindings>, String> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());            // <exe_dir>/pdfium.dll
            dirs.push(parent.join("bin"));              // <exe_dir>/bin/pdfium.dll (resource bundle)
        }
    }
    dirs.push(std::path::PathBuf::from("./bin"));        // dev: working-dir = src-tauri
    dirs.push(std::path::PathBuf::from("."));
    for dir in &dirs {
        let lib = Pdfium::pdfium_platform_library_name_at_path(dir);
        if let Ok(bindings) = Pdfium::bind_to_library(&lib) {
            return Ok(bindings);
        }
    }
    Pdfium::bind_to_system_library()
        .map_err(|e| format!("Khong tim thay pdfium.dll (da thu canh exe, ./bin va system): {:?}", e))
}

/// Bind thư viện pdfium MỘT LẦN. Trả về Result để KHÔNG panic khi không tìm thấy
/// dll (panic trong spawn_blocking sẽ làm task render crash → "Task panicked").
fn ensure_pdfium() -> Result<&'static Pdfium, String> {
    if let Some(p) = PDFIUM_STATIC.get() {
        return Ok(p.0);
    }
    let bindings = bind_pdfium()?;
    let leaked: &'static Pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
    // Nếu thread khác đã set trước (race), bản leaked này bị bỏ qua (rò rỉ nhỏ, vô hại).
    let _ = PDFIUM_STATIC.set(SyncPdfium(leaked));
    Ok(PDFIUM_STATIC.get().unwrap().0)
}

// In-Memory LRU Tile Cache (Stores ~200 last rendered JPEGs)
struct TileCache {
    map: HashMap<String, Vec<u8>>,
    queue: std::collections::VecDeque<String>,
    max_size: usize,
}
impl TileCache {
    fn new(max_size: usize) -> Self {
        Self { map: HashMap::new(), queue: std::collections::VecDeque::new(), max_size }
    }
    fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        if self.map.contains_key(key) {
            self.queue.retain(|k| k != key);
            self.queue.push_back(key.to_string());
            self.map.get(key).cloned()
        } else { None }
    }
    fn insert(&mut self, key: String, data: Vec<u8>) {
        if self.map.contains_key(&key) {
            self.queue.retain(|k| k != &key);
        } else if self.map.len() >= self.max_size {
            if let Some(oldest) = self.queue.pop_front() {
                self.map.remove(&oldest);
            }
        }
        self.queue.push_back(key.clone());
        self.map.insert(key, data);
    }
}
static TILE_CACHE: OnceLock<Mutex<TileCache>> = OnceLock::new();
static LOAD_LOCK: Mutex<()> = Mutex::new(());

// The State wrapper in Tauri requires Send + Sync
pub struct PdfiumState {
    pdfium: Option<Pdfium>,
}

struct SystemFilesState(Mutex<Vec<String>>);
unsafe impl Send for PdfiumState {}
unsafe impl Sync for PdfiumState {}

#[tauri::command]
fn append_perf_log(app_handle: tauri::AppHandle, msg: String) {
    if let Ok(desktop_dir) = app_handle.path().desktop_dir() {
        let file_path = desktop_dir.join("PrynX_Performance.log");
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(file_path) {
            use std::io::Write;
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
            let _ = writeln!(&mut file, "[{}] {}", now, msg);
        }
    }
}

#[tauri::command]
async fn get_pdf_metadata(app_handle: tauri::AppHandle, file_path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let start_time = std::time::Instant::now();
        let pdfium = ensure_pdfium()?;
        
        let cache_lock = DOC_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let mut cache = cache_lock.lock().map_err(|_| "Cache lock error")?;
        
        let mut load_ms = 0;
        if !cache.contains_key(&file_path) {
            let load_start = std::time::Instant::now();
            // Lazy pool: open only 1 handle immediately for fast metadata access
            let doc = {
                let _guard = LOAD_LOCK.lock().unwrap();
                let bytes = std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;
                pdfium.load_pdf_from_byte_vec(bytes, None)
                    .map_err(|e| format!("Failed to open PDF: {:?}", e))?
            };
            load_ms = load_start.elapsed().as_millis();
            
            let pool_size = get_doc_pool_size();
            let mut pool = Vec::with_capacity(pool_size);
            for _ in 0..pool_size {
                pool.push(OnceLock::new());
            }
            let _ = pool[0].set(DocHandle { doc, lock: Mutex::new(()), pages: Mutex::new(PageLru::new(10)) });
            cache.insert(file_path.clone(), Arc::new(CachedDocument {
                pool,
                next: AtomicUsize::new(0),
            }));
        }
        
        let document_arc = Arc::clone(cache.get(&file_path).unwrap());
        drop(cache);

        let handle = document_arc.pool[0].get().unwrap();
        let _guard = handle.lock.lock().unwrap();
        let document = &handle.doc;
        let num_pages = document.pages().len();
        
        let mut width_pt = 595.0; // Default A4
        let mut height_pt = 842.0;
        
        let mut all_dims = serde_json::Map::new();

        if num_pages > 0 {
            let pages = document.pages();
            
            // First page for global dimensions
            if let Ok(page) = pages.get(0) {
                let raw_w = page.width().value;
                let raw_h = page.height().value;
                
                let rot = page.rotation().unwrap_or(pdfium_render::prelude::PdfPageRenderRotation::None);
                let is_rotated = matches!(rot, pdfium_render::prelude::PdfPageRenderRotation::Degrees90 | pdfium_render::prelude::PdfPageRenderRotation::Degrees270);
                let (mut w, mut h) = if is_rotated { (raw_h, raw_w) } else { (raw_w, raw_h) };
                
                if w < 1.0 { w = 595.0; }
                if h < 1.0 { h = 842.0; }
                width_pt = w;
                height_pt = h;
            }
            
            // Read dimensions for ALL pages (fast enough in Rust/C++)
            let max_to_read = std::cmp::min(num_pages, 2000); // Read up to 2000 pages to prevent extreme latency
            for i in 0..num_pages {
                if i < max_to_read {
                    if let Ok(page) = pages.get(i) {
                        let raw_w = page.width().value;
                        let raw_h = page.height().value;
                        
                        let rot = page.rotation().unwrap_or(pdfium_render::prelude::PdfPageRenderRotation::None);
                        let is_rotated = matches!(rot, pdfium_render::prelude::PdfPageRenderRotation::Degrees90 | pdfium_render::prelude::PdfPageRenderRotation::Degrees270);
                        let (mut pw, mut ph) = if is_rotated { (raw_h, raw_w) } else { (raw_w, raw_h) };
                        
                        if pw < 1.0 { pw = 595.0; }
                        if ph < 1.0 { ph = 842.0; }
                        all_dims.insert((i as usize + 1).to_string(), serde_json::json!({
                            "widthPt": pw,
                            "heightPt": ph
                        }));
                        continue;
                    }
                }
                
                // Fallback for pages beyond limit or failed to read
                all_dims.insert((i as usize + 1).to_string(), serde_json::json!({
                    "widthPt": width_pt,
                    "heightPt": height_pt
                }));
            }
        }
        
        Ok(serde_json::json!({
            "numPages": num_pages,
            "widthPt": width_pt,
            "heightPt": height_pt,
            "allDims": all_dims
        }))
    }).await.unwrap_or_else(|_| Err("Task panicked".into()))
}

// ═══ Shared tile rendering core (used by both IPC command and protocol handler) ═══
fn render_tile_jpeg(
    file_path: &str, page: i32, zoom: f32, rotation: i32,
    clip_x: Option<i32>, clip_y: Option<i32>, clip_w: Option<i32>, clip_h: Option<i32>
) -> Result<Vec<u8>, String> {
    // RENDER_VER: đổi token này mỗi khi thay đổi cách render/encode (LCD text, JPEG
    // quality...) → vô hiệu MỌI tile cache cũ (RAM + đĩa) render bằng cấu hình cũ.
    // Nếu không, tile q92/không-LCD đã lưu vẫn được đọc lại, che mất thay đổi (2026-07-06).
    const RENDER_VER: &str = "v5_q90";
    let cache_key = format!("{}_{}_{}_{}_{}_{}_{}_{}_{}", RENDER_VER, file_path, page, zoom, rotation,
        clip_x.unwrap_or(0), clip_y.unwrap_or(0), clip_w.unwrap_or(0), clip_h.unwrap_or(0));

    {
        let cache_lock = TILE_CACHE.get_or_init(|| Mutex::new(TileCache::new(500)));
        if let Ok(mut cache) = cache_lock.lock() {
            if let Some(data) = cache.get(&cache_key) {
                return Ok(data);
            }
        }
    }

    // Cache ĐĨA: nếu tile đã từng render (mở lại/cuộn lại/zoom cũ) → đọc thẳng, khỏi render.
    {
        let dpath = tile_disk_path(&cache_key);
        if let Ok(bytes) = std::fs::read(&dpath) {
            if !bytes.is_empty() {
                let cache_lock = TILE_CACHE.get_or_init(|| Mutex::new(TileCache::new(500)));
                if let Ok(mut cache) = cache_lock.lock() {
                    cache.insert(cache_key.clone(), bytes.clone());
                }
                return Ok(bytes);
            }
        }
    }

    let pdfium = ensure_pdfium()?;
    
    let cache_lock = DOC_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache_lock.lock().map_err(|_| "Cache lock error")?;
    
    if !cache.contains_key(file_path) {
        // Fallback lazy pool init (normally get_pdf_metadata initializes this)
        let pool_size = get_doc_pool_size();
        let mut pool = Vec::with_capacity(pool_size);
        for _ in 0..pool_size {
            pool.push(OnceLock::new());
        }
        let bytes = std::fs::read(&file_path).map_err(|e| format!("FS read error: {}", e))?;
        let doc = {
            let _guard = LOAD_LOCK.lock().unwrap();
            pdfium.load_pdf_from_byte_vec(bytes, None)
                .map_err(|e| format!("Failed to open PDF: {:?}", e))?
        };
        let _ = pool[0].set(DocHandle { doc, lock: Mutex::new(()), pages: Mutex::new(PageLru::new(10)) });
        cache.insert(file_path.to_string(), Arc::new(CachedDocument {
            pool,
            next: AtomicUsize::new(0),
        }));
    }
    
    let document_arc = Arc::clone(cache.get(file_path).unwrap());
    drop(cache);
    
    let pool_size = document_arc.pool.len();
    let pool_idx = document_arc.next.fetch_add(1, Ordering::Relaxed) % pool_size;
    
    // LAZY INITIALIZATION of the DocHandle. KHÔNG dùng get_or_init + .expect():
    // .expect() panic trong spawn_blocking → "Task panicked" che lỗi thật (file PDF
    // bị xoá/khoá/hỏng giữa phiên). Khởi tạo thủ công + propagate lỗi sạch (§15.7).
    let cell = &document_arc.pool[pool_idx];
    if cell.get().is_none() {
        let doc = {
            let _guard = LOAD_LOCK.lock().map_err(|_| "Load lock poisoned".to_string())?;
            let bytes = std::fs::read(file_path).map_err(|e| format!("FS read error (lazy): {}", e))?;
            pdfium.load_pdf_from_byte_vec(bytes, None)
                .map_err(|e| format!("Failed to open PDF (lazy): {:?}", e))?
        };
        // Race-safe: nếu thread khác set trước, set này trả Err → bỏ qua (doc thừa drop, vô hại).
        let _ = cell.set(DocHandle { doc, lock: Mutex::new(()), pages: Mutex::new(PageLru::new(10)) });
    }
    let handle = cell.get().ok_or_else(|| "DocHandle init failed".to_string())?;
    
    let rgba_image = {
        let _guard = handle.lock.lock().unwrap();
        let page_index = (page - 1) as u16;
        if page_index >= handle.doc.pages().len() {
            return Err("Page out of bounds".into());
        }
        // Lấy page từ cache LRU. Giữ PdfPage MỞ giữa các lần render để pdfium TÁI DÙNG
        // ảnh đã giải nén (giun.pdf: 16MB ảnh/trang). Nếu mở page mới mỗi lần render,
        // pdfium giải nén lại toàn bộ → ~600-1300ms; tái dùng page → ~120ms.
        let mut lru = handle.pages.lock().unwrap();
        if !lru.map.contains_key(&page_index) {
            // SAFETY: page mượn từ handle.doc; doc nằm trong Pdfium đã Box::leak ('static),
            // sống suốt vòng đời tiến trình, nên kéo dài borrow lên 'static là hợp lệ ở đây.
            let doc_ref: &'static PdfDocument<'static> = unsafe {
                std::mem::transmute::<&PdfDocument<'static>, &'static PdfDocument<'static>>(&handle.doc)
            };
            let new_page = doc_ref.pages().get(page_index)
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
        let pdf_page = lru.map.get(&page_index).unwrap();
        
        let mut render_scale = (96.0 / 72.0) * zoom as f32;
        if render_scale.is_nan() || render_scale.is_infinite() {
            render_scale = 1.0;
        }
        // CHỈ chặn cận DƯỚI. KHÔNG clamp cận trên: clip_x/y do frontend tính ở scale
        // THẬT (zoom×dpr); nếu clamp render_scale mà translate = -x/render_scale thì tile
        // trỏ SAI vùng → mất nội dung ở zoom cao (bug viewport-tiling). An toàn OOM vì:
        // nhánh clip bị set_fixed_size ≤4000px chặn bitmap; nhánh full-page tự hạ scale
        // bằng max_dim=8000 bên dưới. Nên trần scale là THỪA và chính là thứ phá tile.
        render_scale = render_scale.max(0.01);

        let render_config = if let (Some(x), Some(y), Some(w), Some(h)) = (clip_x, clip_y, clip_w, clip_h) {
            let safe_w = w.clamp(1, 4000) as i32;
            let safe_h = h.clamp(1, 4000) as i32;
            PdfRenderConfig::new()
                .set_clear_color(PdfColor::WHITE)
                .set_fixed_size(safe_w, safe_h)
                .translate(PdfPoints::new(-(x as f32) / render_scale), PdfPoints::new(-(y as f32) / render_scale)).unwrap_or_default()
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
        let bitmap = pdf_page.render_with_config(&render_config)
            .map_err(|e| format!("Failed to render page: {:?}", e))?;
        bitmap.as_image().to_rgba8()
    };

    let mut buffer = Vec::new();
    // JPEG-90: encode ~40% nhanh hơn q98 (audit tốc độ 2026-07-06: encode ~59ms là khâu
    // LỚN NHẤT/tile sau khi debounce cắt render thừa). q90 vẫn ≥90 → image-crate giữ 4:4:4
    // (KHÔNG subsample màu → biên màu vẫn sắc); chỉ giảm nhẹ lượng tử hoá DCT, mắt thường
    // gần như không phân biệt với q98 trên ảnh render màn hình. (Từng: q92→q98 cho nét, nay
    // hạ q90 đổi lấy tốc độ vì debounce đã đảm bảo mỗi lần zoom chỉ 1 render.)
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 90);
    encoder.encode_image(&rgba_image).map_err(|e| format!("Encode error: {:?}", e))?;
    // LƯU Ý: ĐÃ GỠ block ghi PrynX_Performance.log ở đây — nó gọi chrono::Local::now()
    // và PANIC ở bản release ("Task panicked"), khiến render_tile_jpeg trả 500 → main view
    // kẹt RENDERING + thumbnail vỡ. Đây là nguyên nhân gốc thật sự (xem frontend_debug.log).
    
    {
        let cache_lock = TILE_CACHE.get_or_init(|| Mutex::new(TileCache::new(500)));
        if let Ok(mut cache) = cache_lock.lock() {
            // Ghi ĐĨA trước (cần &cache_key) rồi mới move cache_key vào RAM cache.
            let dpath = tile_disk_path(&cache_key);
            let _ = std::fs::write(&dpath, &buffer);
            // Prune ĐỊNH KỲ trên THREAD NỀN (không chặn việc trả tile về). Bỏ qua lần ghi
            // đầu (n=0) và chỉ chạy mỗi 64 lần ghi. Trước đây prune chạy ĐỒNG BỘ ngay lần
            // ghi đầu + quét cả thư mục cache (tích lũy nhiều ngày → hàng nghìn file) →
            // chặn trả tile vài giây ở lần mở đầu phiên (regression "hôm qua nhanh nay chậm").
            let n = DISK_CACHE_WRITES.fetch_add(1, Ordering::Relaxed);
            if n > 0 && n % 64 == 0 {
                std::thread::spawn(|| prune_tile_cache_dir(3000));
            }
            cache.insert(cache_key, buffer.clone());
        }
    }
    
    Ok(buffer)
}

// Giới hạn render đồng thời cho lệnh IPC render_pdf_page (giống TILE_SEMAPHORE của
// đường tile://). Viewport-tiling gửi nhiều ô cùng lúc → nếu không chặn, mỗi render
// round-robin qua doc pool khiến mỗi handle decode lại page (RAM) + spawn_blocking
// không giới hạn. Semaphore ~4 giữ song song vừa phải, tránh thrash (audit render).
static RENDER_SEMAPHORE: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();

#[tauri::command]
async fn render_pdf_page(
    _app_handle: tauri::AppHandle,
    file_path: String, page: i32, zoom: f32, rotation: i32,
    clip_x: Option<i32>, clip_y: Option<i32>, clip_w: Option<i32>, clip_h: Option<i32>,
) -> Result<tauri::ipc::Response, String> {
    let sem = RENDER_SEMAPHORE.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
    let _permit = sem.acquire().await.map_err(|_| "Render semaphore closed".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        match render_tile_jpeg(&file_path, page, zoom, rotation, clip_x, clip_y, clip_w, clip_h) {
            Ok(data) => Ok(tauri::ipc::Response::new(data)),
            Err(e) => {
                // Ghi LÝ DO thật ra log (release tắt devtools → console.error phía JS biến
                // mất). Đây là manh mối chẩn đoán "xem trước trắng" trên máy khách: pdfium
                // OOM/clamp tờ lớn, file backend sinh hỏng, hết RAM, page out of bounds...
                log::error!(
                    "[RENDER] Fail file='{}' page={} zoom={} rot={}: {}",
                    file_path, page, zoom, rotation, e
                );
                Err(e)
            }
        }
    }).await.unwrap_or_else(|_| {
        // Task panic (vd STATUS_STACK_BUFFER_OVERRUN khi bitmap tờ booklet quá lớn) —
        // trước đây nuốt lý do thành "Task panicked" chung chung. Ghi lại để lần theo.
        log::error!("[RENDER] Task panicked (khả năng pdfium crash: bitmap quá lớn / OOM)");
        Err("Task panicked".into())
    })
}

#[tauri::command]
fn get_startup_args() -> Vec<String> {
    std::env::args().collect()
}

#[tauri::command]
/// SECURITY (đồng bộ với fs capability deny): từ chối đọc các vị trí nhạy cảm
/// (khóa SSH/AWS/GnuPG, credential store Windows) + chặn path traversal ("..").
/// Áp cho các lệnh Rust đọc file vì capability `deny` chỉ ràng plugin-fs, KHÔNG
/// ràng lệnh Rust tự viết. Không ảnh hưởng mở PDF/ảnh (không nằm ở các thư mục này).
fn is_sensitive_path(path: &str) -> bool {
    let norm = path.replace('/', "\\").to_lowercase();
    // Chống path traversal
    if norm.contains("\\..\\") || norm.ends_with("\\..") || norm.starts_with("..\\") {
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
        ".ssh", ".aws", ".gnupg", ".config", ".kube",
        "appdata\\local\\microsoft\\credentials",
        "appdata\\roaming\\microsoft\\credentials",
    ];
    blocked
        .iter()
        .any(|s| norm.starts_with(&format!("{}\\{}", home_l, s)))
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
    for var in ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                sys_dirs.push(v.replace('/', "\\").to_lowercase());
            }
        }
    }
    sys_dirs.iter().any(|d| norm == *d || norm.starts_with(&format!("{}\\", d)))
}

#[tauri::command]
fn read_system_file(path: String) -> Result<Response, String> {
    // Security: only allow known file types to prevent arbitrary file reads
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = ["pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "icc", "icm", "svg", "ttf", "otf", "ttc"];
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
    if is_sensitive_path(&path) {
        return Err("Access to this location is not allowed".to_string());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Lỗi lấy metadata: {}", e))?;
    Ok(metadata.len())
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
    let allowed = ["pdf", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "svg", "csv", "txt", "json"];
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
    let fname = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("out");
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
fn get_pending_system_files(state: tauri::State<SystemFilesState>) -> Vec<String> {
    let mut pending = state.0.lock().unwrap();
    let files = pending.clone();
    pending.clear();
    files
}

#[tauri::command]
async fn normalize_image_to_png(file_path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&file_path).map_err(|e| format!("Failed to open image: {}", e))?;
        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Png).map_err(|e| format!("Failed to encode image: {}", e))?;
        Ok(tauri::ipc::Response::new(buffer.into_inner()))
    }).await.unwrap_or_else(|_| Err("Task panicked".to_string()))
}

#[tauri::command]
async fn normalize_image_bytes(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::load_from_memory(&bytes).map_err(|e| format!("Failed to load image from memory: {}", e))?;
        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Png).map_err(|e| format!("Failed to encode image: {}", e))?;
        Ok(tauri::ipc::Response::new(buffer.into_inner()))
    }).await.unwrap_or_else(|_| Err("Task panicked".to_string()))
}

#[tauri::command]
fn solve_layout(
    usable_w: f64, usable_h: f64,
    orig_w: f64, orig_h: f64,
    gap_x: f64, gap_y: f64,
    strategy: String,
) -> Result<serde_json::Value, String> {
    // Dùng nguồn chân lý duy nhất: imposition_core (Task 9 / Req 1.3).
    let result = imposition_core::grid::solve_optimal_layout(
        usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, &strategy, None,
    );
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {}", e))
}

// ══════════════════════════════════════════════════════════════
// VECTOR #3 FIX: Sidecar binary integrity verification
// Computes SHA-256 of the Python sidecar and compares against
// the expected hash. Prevents binary replacement attacks.
// ══════════════════════════════════════════════════════════════

/// Compute SHA-256 hash of a file
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    use sha2::{Sha256, Digest};
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Cannot open sidecar binary: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let bytes_read = file.read(&mut buffer)
            .map_err(|e| format!("Cannot read sidecar binary: {}", e))?;
        if bytes_read == 0 { break; }
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
        return Err(
            "PRYNX_SIDECAR_HASH not set at build time. \
             Set env var before running cargo build --release.".to_string()
        );
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
                sidecar_path.display(), e
            );
            return Err(format!(
                "Security error: cannot verify backend integrity ({}). \
                 The backend file may be missing, quarantined by antivirus, or tampered with.", e
            ));
        }
    };
    if actual_hash != expected_hash {
        log::error!(
            "[INTEGRITY] Sidecar binary has been tampered! Expected={}, Got={}",
            expected_hash, actual_hash
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
        return Err(
            "PRYNX_FRONTEND_HASH not set at build time. \
             Set env var before running cargo build --release.".to_string()
        );
    }
    
    // Frontend dist is in the resource directory
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("Cannot find resource dir: {}", e))?;
    
    // Try multiple possible dist locations
    // FAIL-CLOSED: nếu KHÔNG tìm thấy nơi chứa frontend (dist/ hoặc index.html) thì
    // KHÔNG cho qua — đây là dấu hiệu bị nghịch (đổi tên/di dời file để né check).
    // Bản cài hợp lệ LUÔN có dist ở resource_dir; thiếu = bất thường → chặn khởi động.
    let dist_dir = if resource_dir.join("dist").is_dir() {
        resource_dir.join("dist")
    } else if resource_dir.join("index.html").exists() {
        resource_dir.clone()
    } else {
        log::error!(
            "[INTEGRITY] Frontend dist dir not found under {} — refusing to start.",
            resource_dir.display()
        );
        return Err(
            "Security error: cannot locate frontend files to verify integrity. \
             The application may have been tampered with.".to_string()
        );
    };
    
    // Hash ALL files in dist/ recursively, sorted by path for determinism
    let actual_hash = sha256_directory(&dist_dir)?;
    if actual_hash != expected_hash {
        log::error!("[INTEGRITY] Frontend tampered! Expected={}, Got={}", expected_hash, actual_hash);
        return Err("Security error: frontend files have been tampered with.".to_string());
    }
    
    log::info!("[INTEGRITY] Frontend integrity verified OK (full directory hash)");
    Ok(())
}

/// Hash all files in a directory recursively, sorted by relative path.
#[cfg(not(debug_assertions))]
fn sha256_directory(dir: &std::path::Path) -> Result<String, String> {
    use sha2::{Sha256, Digest};
    
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
            let n = file.read(&mut buffer)
                .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;
            if n == 0 { break; }
            hasher.update(&buffer[..n]);
        }
    }
    
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(not(debug_assertions))]
fn collect_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read dir {}: {}", dir.display(), e))?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic hook: ghi mọi panic (message + vị trí) ra %APPDATA%\PrynX\logs\rust_panic.log
    // để chẩn đoán sự cố ở bản release (nơi không có stdout/console).
    std::panic::set_hook(Box::new(|info| {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let dir = std::path::Path::new(&appdata).join("PrynX").join("logs");
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("rust_panic.log")) {
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
        let merged = if existing.trim().is_empty() { flags.to_string() } else { format!("{} {}", existing, flags) };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }

    tauri::Builder::default()
        .manage(Mutex::new(PdfiumState { pdfium: None }))
        .manage(SystemFilesState(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![render_pdf_page, get_pdf_metadata, get_startup_args, read_system_file, get_file_size, get_pending_system_files, write_file_atomic, append_perf_log, pdf_engine::diecut::strip_diecut_lines, solve_layout, security::get_hardware_id, security::store_license, security::load_license, security::delete_license, security::register_validated_key, security::clear_validated_keys, security::sign_api_request, security::store_last_online, security::load_last_online, security::store_license_token, security::load_license_token, security::delete_license_token, normalize_image_to_png, normalize_image_bytes])
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(state) = app.try_state::<SystemFilesState>() {
                if let Ok(mut pending) = state.0.lock() {
                    pending.extend(args);
                }
            }
            
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_always_on_top(true);
                let _ = window.set_always_on_top(false);
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
            // VECTOR #15 FIX: SetProcessMitigationPolicy
            // Block unsigned DLL injection + dynamic code generation
            // ══════════════════════════════════════════════════════════════
            #[cfg(not(debug_assertions))]
            {
                // QUAN TRỌNG (root-cause "release render chết / thumbnail vỡ"):
                // pdfium.dll là DLL BÊN THỨ 3, KHÔNG ký bởi Microsoft. Nếu bật
                // ProcessSignaturePolicy(MicrosoftSignedOnly) TRƯỚC khi nạp nó thì
                // LoadLibrary(pdfium.dll) bị chặn → error 577 (ERROR_INVALID_IMAGE_HASH)
                // → mọi render PDF (main view + thumbnail + bình tem) thất bại.
                // Một DLL đã nạp vào tiến trình thì policy KHÔNG gỡ ra → warmup pdfium
                // NGAY TẠI ĐÂY (trước policy) để nó hoạt động, mà vẫn chặn được DLL lạ
                // bị inject về SAU. (Dev không chạy block này nên không gặp lỗi.)
                match ensure_pdfium() {
                    Ok(_) => log::info!("[SECURITY] pdfium warmed up before signature policy"),
                    Err(e) => log::error!("[SECURITY] pdfium warmup FAILED before policy: {}", e),
                }

                unsafe {
                    use std::ffi::c_void;
                    
                    #[repr(C)]
                    struct BinarySignaturePolicy {
                        flags: u32,
                    }
                    
                    #[repr(C)]
                    struct DynamicCodePolicy {
                        flags: u32,
                    }

                    #[link(name = "kernel32")]
                    extern "system" {
                        fn SetProcessMitigationPolicy(
                            policy: i32,
                            info: *const c_void,
                            length: usize,
                        ) -> i32;
                    }
                    
                    // ProcessSignaturePolicy = 8: Only load Microsoft-signed DLLs
                    let sig_policy = BinarySignaturePolicy { flags: 0x1 }; // MicrosoftSignedOnly
                    let _ = SetProcessMitigationPolicy(
                        8,
                        &sig_policy as *const _ as *const c_void,
                        std::mem::size_of::<BinarySignaturePolicy>(),
                    );
                    
                    // ProcessDynamicCodePolicy = 2: Prevent dynamic code (blocks Frida/CE)
                    let code_policy = DynamicCodePolicy { flags: 0x1 }; // ProhibitDynamicCode
                    let _ = SetProcessMitigationPolicy(
                        2,
                        &code_policy as *const _ as *const c_void,
                        std::mem::size_of::<DynamicCodePolicy>(),
                    );
                    
                    log::info!("[SECURITY] Process mitigation policies applied");
                }

                // Start anti-debug background monitor (checks every 5 seconds)
                security::start_anti_debug_monitor();
            }

            // VECTOR #4 FIX: Verify frontend JS hasn't been tampered with
            #[cfg(not(debug_assertions))]
            {
                if let Err(e) = verify_frontend_integrity(app) {
                    log::error!("[SECURITY] {}", e);
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
                    let _ = std::process::Command::new("powershell")
                        .args(["-NoProfile", "-Command", &format!(
                            "[System.Windows.MessageBox]::Show('{}', 'PrynX Security', 'OK', 'Error')",
                            e.replace('\'', "''")
                        )])
                        .creation_flags(0x08000000)
                        .output();
                    std::process::exit(1);
                }

                let sidecar = match app.shell().sidecar("pdf-inspector-backend") {
                    Ok(s) => s,
                    Err(e) => {
                        log::error!("[SIDECAR] Khong tim thay binary sidecar: {}", e);
                        let _ = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-Command",
                                "[System.Windows.MessageBox]::Show('Khong tim thay tien trinh nen (pdf-inspector-backend.exe). Co the bi phan mem diet virus cach ly hoac thieu file. Vui long khoi phuc/loai tru file roi mo lai ung dung.', 'PrynX', 'OK', 'Error')"])
                            .creation_flags(0x08000000)
                            .output();
                        std::process::exit(1);
                    }
                };
                let spawn_result = sidecar
                    .args(["--port", "8321"])
                    .envs([
                        ("DEV_MODE", "false"),
                        // Signal sidecar to read token from stdin instead of file
                        ("PRYNX_TOKEN_SOURCE", "stdin"),
                        // Cưỡng chế token license server-ký: backend từ chối mọi request
                        // không kèm token Ed25519 hợp lệ (do edge function Supabase phát).
                        // Client bị crack không giả được token → không gọi được backend.
                        ("PRYNX_ENFORCE_LICENSE_TOKEN", "true"),
                        // Cận chống-lùi-giờ PHẢI ≥ TTL token edge function cấp (hiện 7 ngày).
                        // Set qua env để override default compiled cũ mà KHÔNG cần recompile Nuitka.
                        // 8 ngày = 8*24*60*60 = 691200s (7 ngày TTL + 1 ngày dư).
                        ("PRYNX_MAX_TOKEN_LIFETIME_SECONDS", "691200"),
                    ])
                    .spawn();
                let (_rx, mut child) = match spawn_result {
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
                
                // Lưu PID để KILL cả cây tiến trình khi thoát app (chống treo ngầm →
                // update NSIS không ghi đè được file). set() 1 lần, bỏ qua nếu đã có.
                let _ = SIDECAR_PID.set(child.pid());

                // Write token via stdin pipe — no file on disk ever
                let token_line = format!("TOKEN:{}\n", sidecar_token);
                if let Err(e) = child.write(token_line.as_bytes()) {
                    // Không panic: log lại; backend không có token sẽ tự từ chối request (fail-closed).
                    log::error!("[SIDECAR] Ghi token vao stdin that bai: {}", e);
                }

                log::info!("Python backend sidecar started on port 8321 (token via stdin pipe)");
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

            Ok(())
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
                    
                    render_tile_jpeg(&file_path, page, zoom, rot, clip_x, clip_y, clip_w, clip_h)
                }).await;
                
                match res {
                    Ok(Ok(jpeg_bytes)) => {
                        let resp = http::Response::builder()
                            .status(200)
                            .header("Content-Type", "image/jpeg")
                            .header("Cache-Control", "max-age=3600, immutable")
                            .body(jpeg_bytes)
                            .unwrap();
                        responder.respond(resp);
                    }
                    Ok(Err(e)) => {
                        let resp = http::Response::builder()
                            .status(500)
                            .body(format!("Render error: {}", e).into_bytes())
                            .unwrap();
                        responder.respond(resp);
                    }
                    Err(e) => {
                        let resp = http::Response::builder()
                            .status(500)
                            .body(format!("Join error: {}", e).into_bytes())
                            .unwrap();
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
