//! Print worker out-of-process — driver GDI crash không kéo sập process UI.
//!
//! Parent ghi job JSON → spawn `PrynX.exe --prynx-print-job <in> --prynx-print-result <out>`
//! → worker chạy blocking GDI/PDFium → ghi result JSON → exit.
//! Nếu worker AV/exit bất thường, parent chỉ nhận lỗi, app chính còn sống.

#[cfg(windows)]
use super::print::{
    get_printer_geometry_blocking, list_printers_blocking, open_printer_properties_blocking,
    parse_scale_mode_pub, print_direct_blocking, print_pdf_blocking, resolve_scale_mode_pub,
    PrintJobControl,
};
use super::print::{print_breadcrumb, PrinterGeometry, PrinterInfo};
#[cfg(windows)]
use super::print_layout::{LayoutMode, PageSubset};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug)]
struct ActivePrintWorker {
    pid: u32,
    cancel_path: PathBuf,
}

/// Registry chỉ chứa worker IN. Worker đọc geometry/list/properties không bao giờ được ghi đè.
static ACTIVE_PRINT_WORKERS: OnceLock<Mutex<HashMap<String, ActivePrintWorker>>> = OnceLock::new();

fn active_print_workers() -> &'static Mutex<HashMap<String, ActivePrintWorker>> {
    ACTIVE_PRINT_WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PrintWorkerJob {
    ListPrinters,
    Geometry {
        printer_name: String,
        orientation: Option<String>,
        devmode: Option<Vec<u8>>,
    },
    /// UI thuộc tính driver — worker tự tạo cửa sổ owner cùng process
    /// (PRINTWIN §PRINTWIN.01/§PRINTWIN.03); crash chỉ giết worker.
    OpenProperties {
        printer_name: String,
        current_devmode: Option<Vec<u8>>,
        advanced: bool,
    },
    PrintDirect {
        job_id: String,
        cancel_path: String,
        progress_path: String,
        file_path: String,
        printer_name: String,
        output_path: Option<String>,
        from_page: Option<i32>,
        to_page: Option<i32>,
        #[serde(default)]
        pages: Option<Vec<i32>>,
        copies: i32,
        collate: bool,
        scale_mode: String,
        scale_percent: Option<f64>,
        orientation: Option<String>,
        auto_rotate: bool,
        grayscale: bool,
        print_annotations: bool,
        reverse: bool,
        page_subset: Option<String>,
        layout_mode: Option<String>,
        pages_per_sheet: u32,
        poster_cols: u32,
        poster_rows: u32,
        devmode: Option<Vec<u8>>,
    },
    PrintDlg {
        file_path: String,
        from_page: Option<i32>,
        to_page: Option<i32>,
        #[serde(default)]
        pages: Option<Vec<i32>>,
        scale_mode: Option<String>,
        auto_rotate: bool,
        /// PRINTWIN (audit 2026-08-13 §PRINTWIN.03): app luôn gửi 0 — HWND xuyên
        /// process làm Windows disable cửa sổ PrynX khi worker chết. Giá trị 0 khiến
        /// print_pdf_blocking tự tạo owner cùng process; field giữ lại cho tương thích.
        owner_hwnd: isize,
    },
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PrintWorkerResult {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub printers: Option<Vec<PrinterInfo>>,
    #[serde(default)]
    pub geometry: Option<PrinterGeometry>,
    #[serde(default)]
    pub printed: Option<bool>,
    #[serde(default)]
    pub devmode: Option<Vec<u8>>,
}

/// PRINTWIN (audit 2026-08-13 §PRINTWIN.04): PrintDlgW và UI driver (Adobe PDF, XPS,
/// driver hãng) yêu cầu COM/OLE đã khởi tạo trên thread gọi — thiếu thì lỗi tùy driver
/// (êm trên Microsoft Print to PDF, chết trên driver xưởng). Guard giữ OLE sống suốt
/// vòng đời worker và trả lại đúng thứ tự khi thoát.
struct OleGuard {
    #[cfg_attr(not(windows), allow(dead_code))]
    initialized: bool,
}

impl OleGuard {
    fn init() -> Self {
        #[cfg(windows)]
        {
            // S_OK/S_FALSE đều thành công; lỗi (vd thread đã MTA) thì vẫn chạy tiếp —
            // không chặn job in chỉ vì thiếu OLE, driver cơ bản vẫn hoạt động.
            let initialized =
                unsafe { windows::Win32::System::Ole::OleInitialize(None).is_ok() };
            if !initialized {
                print_breadcrumb("worker: OleInitialize failed (tiếp tục không OLE)");
            }
            Self { initialized }
        }
        #[cfg(not(windows))]
        {
            Self { initialized: false }
        }
    }
}

impl Drop for OleGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.initialized {
            unsafe { windows::Win32::System::Ole::OleUninitialize() };
        }
    }
}

/// Entry point khi process được spawn với --prynx-print-job. Trả exit code.
pub fn run_print_worker(job_path: &str, result_path: &str) -> i32 {
    let _ole = OleGuard::init();
    print_breadcrumb(&format!("worker: start job={}", job_path));
    let job_raw = match std::fs::read_to_string(job_path) {
        Ok(s) => s,
        Err(e) => {
            let _ = write_result(
                result_path,
                &PrintWorkerResult {
                    ok: false,
                    error: Some(format!("Không đọc được job: {e}")),
                    printers: None,
                    geometry: None,
                    printed: None,
                    devmode: None,
                },
            );
            return 2;
        }
    };
    let job: PrintWorkerJob = match serde_json::from_str(&job_raw) {
        Ok(j) => j,
        Err(e) => {
            let _ = write_result(
                result_path,
                &PrintWorkerResult {
                    ok: false,
                    error: Some(format!("Job JSON hỏng: {e}")),
                    printers: None,
                    geometry: None,
                    printed: None,
                    devmode: None,
                },
            );
            return 2;
        }
    };

    let result = execute_job(job);
    let code = if result.ok { 0 } else { 1 };
    if let Err(e) = write_result(result_path, &result) {
        print_breadcrumb(&format!("worker: write result failed: {e}"));
        return 3;
    }
    print_breadcrumb(&format!(
        "worker: done code={code} error={}",
        result.error.as_deref().unwrap_or("none")
    ));
    code
}

fn write_result(path: &str, r: &PrintWorkerResult) -> Result<(), String> {
    let s = serde_json::to_string(r).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn execute_job(job: PrintWorkerJob) -> PrintWorkerResult {
    match job {
        PrintWorkerJob::ListPrinters => match list_printers_blocking() {
            Ok(printers) => PrintWorkerResult {
                ok: true,
                error: None,
                printers: Some(printers),
                geometry: None,
                printed: None,
                devmode: None,
            },
            Err(e) => err_result(e),
        },
        PrintWorkerJob::Geometry {
            printer_name,
            orientation,
            devmode,
        } => match get_printer_geometry_blocking(printer_name, orientation.as_deref(), devmode) {
            Ok(g) => PrintWorkerResult {
                ok: true,
                error: None,
                printers: None,
                geometry: Some(g),
                printed: None,
                devmode: None,
            },
            Err(e) => err_result(e),
        },
        PrintWorkerJob::OpenProperties {
            printer_name,
            current_devmode,
            advanced,
        } => match open_printer_properties_blocking(0, printer_name, current_devmode, advanced) {
            Ok(dm) => PrintWorkerResult {
                ok: true,
                error: None,
                printers: None,
                geometry: None,
                printed: None,
                devmode: dm,
            },
            Err(e) => err_result(e),
        },
        PrintWorkerJob::PrintDirect {
            job_id,
            cancel_path,
            progress_path,
            file_path,
            printer_name,
            output_path,
            from_page,
            to_page,
            pages,
            copies,
            collate,
            scale_mode,
            scale_percent,
            orientation,
            auto_rotate,
            grayscale,
            print_annotations,
            reverse,
            page_subset,
            layout_mode,
            pages_per_sheet,
            poster_cols,
            poster_rows,
            devmode,
        } => {
            let mode = resolve_scale_mode_pub(Some(scale_mode.as_str()), scale_percent);
            let layout = LayoutMode::parse(layout_mode.as_deref());
            let effective_mode = match layout {
                LayoutMode::Booklet | LayoutMode::Poster => {
                    // Fit for booklet/poster — mirror parent
                    resolve_scale_mode_pub(Some("fit"), None)
                }
                _ => mode,
            };
            match print_direct_blocking(
                file_path,
                printer_name,
                from_page,
                to_page,
                pages,
                copies,
                collate,
                effective_mode,
                orientation.as_deref(),
                auto_rotate,
                grayscale,
                print_annotations,
                reverse,
                PageSubset::parse(page_subset.as_deref()),
                layout,
                pages_per_sheet,
                poster_cols,
                poster_rows,
                output_path,
                devmode,
                Some(PrintJobControl {
                    job_id,
                    cancel_path: PathBuf::from(cancel_path),
                    progress_path: PathBuf::from(progress_path),
                }),
            ) {
                Ok(printed) => PrintWorkerResult {
                    ok: true,
                    error: None,
                    printers: None,
                    geometry: None,
                    printed: Some(printed),
                    devmode: None,
                },
                Err(e) => err_result(e),
            }
        }
        PrintWorkerJob::PrintDlg {
            file_path,
            from_page,
            to_page,
            pages,
            scale_mode,
            auto_rotate,
            owner_hwnd,
        } => {
            let mode = parse_scale_mode_pub(scale_mode.as_deref());
            match print_pdf_blocking(
                file_path,
                from_page,
                to_page,
                pages,
                owner_hwnd,
                mode,
                auto_rotate,
            ) {
                Ok(printed) => PrintWorkerResult {
                    ok: true,
                    error: None,
                    printers: None,
                    geometry: None,
                    printed: Some(printed),
                    devmode: None,
                },
                Err(e) => err_result(e),
            }
        }
    }
}

#[cfg(not(windows))]
fn execute_job(_job: PrintWorkerJob) -> PrintWorkerResult {
    err_result("Print worker chỉ hỗ trợ Windows".into())
}

fn err_result(e: String) -> PrintWorkerResult {
    PrintWorkerResult {
        ok: false,
        error: Some(e),
        printers: None,
        geometry: None,
        printed: None,
        devmode: None,
    }
}

/// Spawn worker process, chờ xong, đọc result. Driver crash → lỗi, parent sống.
pub fn run_isolated(job: PrintWorkerJob) -> Result<PrintWorkerResult, String> {
    run_isolated_inner(job, None)
}

/// Spawn job in thật: parent theo dõi đúng PID/job và chuyển progress từ worker sang UI.
pub fn run_isolated_print(
    job: PrintWorkerJob,
    progress_app: tauri::AppHandle,
) -> Result<PrintWorkerResult, String> {
    run_isolated_inner(job, Some(progress_app))
}

/// PRINTWIN (audit 2026-08-13 §PRINTWIN.07): `pid + millis` từng cho phép hai worker
/// spawn trong cùng 1 ms (geometry + properties + print) ghi đè job JSON của nhau.
/// nanos + bộ đếm tăng dần trong process bảo đảm tên file duy nhất.
static WORKER_FILE_SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_worker_file_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}_{}_{}",
        std::process::id(),
        nanos,
        WORKER_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Debug)]
struct PrintRunContext {
    job_id: String,
    cancel_path: PathBuf,
    progress_path: PathBuf,
}

fn print_run_context(job: &PrintWorkerJob) -> Option<PrintRunContext> {
    match job {
        PrintWorkerJob::PrintDirect {
            job_id,
            cancel_path,
            progress_path,
            ..
        } => Some(PrintRunContext {
            job_id: job_id.clone(),
            cancel_path: PathBuf::from(cancel_path),
            progress_path: PathBuf::from(progress_path),
        }),
        _ => None,
    }
}

fn run_isolated_inner(
    job: PrintWorkerJob,
    progress_app: Option<tauri::AppHandle>,
) -> Result<PrintWorkerResult, String> {
    let op_name = match &job {
        PrintWorkerJob::ListPrinters => "list_printers",
        PrintWorkerJob::Geometry { .. } => "geometry",
        PrintWorkerJob::OpenProperties { .. } => "open_properties",
        PrintWorkerJob::PrintDirect { .. } => "print_direct",
        PrintWorkerJob::PrintDlg { .. } => "print_dlg",
    };
    print_breadcrumb(&format!("isolated: spawn op={op_name}"));
    let print_context = print_run_context(&job);

    let temp = std::env::temp_dir();
    let id = unique_worker_file_id();
    let job_path = temp.join(format!("prynx_pj_{id}.json"));
    let out_path = temp.join(format!("prynx_pj_{id}.out.json"));

    let job_json = serde_json::to_string(&job).map_err(|e| format!("Serialize job: {e}"))?;
    std::fs::write(&job_path, job_json).map_err(|e| format!("Ghi job: {e}"))?;

    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--prynx-print-job")
        .arg(&job_path)
        .arg("--prynx-print-result")
        .arg(&out_path);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — worker không bung console
        cmd.creation_flags(0x08000000);
    }

    if let Some(ref ctx) = print_context {
        let mut registry = active_print_workers()
            .lock()
            .map_err(|_| "Registry job in bị khóa lỗi".to_string())?;
        if registry.contains_key(&ctx.job_id) {
            let _ = std::fs::remove_file(&job_path);
            return Err(format!("Job in {} đang chạy", ctx.job_id));
        }
        let _ = std::fs::remove_file(&ctx.cancel_path);
        let _ = std::fs::remove_file(&ctx.progress_path);
        // PERF (audit 2026-08-05 §PRINT.3): registry này chỉ dành cho worker in,
        // không còn bị list/geometry/properties ghi đè PID.
        registry.insert(
            ctx.job_id.clone(),
            ActivePrintWorker {
                pid: 0,
                cancel_path: ctx.cancel_path.clone(),
            },
        );
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            unregister_print_context(print_context.as_ref(), 0);
            let _ = std::fs::remove_file(&job_path);
            return Err(format!("Không spawn print worker: {e}"));
        }
    };
    let child_pid = child.id();
    // [PROC-LIFECYCLE FIX 2026-08-28 §UP.7] Print worker cũng là pdf-inspector.exe nên nó
    // khóa đúng file mà trình cài cần ghi đè; và hộp thoại driver có thể giữ nó rất lâu.
    crate::process_guard::adopt_child_process(child_pid);
    #[cfg(windows)]
    {
        // PRINTWIN (audit 2026-08-13 §PRINTWIN.03): cấp quyền foreground cho worker —
        // process nền không tự đưa PrintDlg/Properties lên trước được; thiếu quyền này
        // hộp thoại driver mở khuất sau cửa sổ PrynX.
        use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
        let _ = unsafe { AllowSetForegroundWindow(child_pid) };
    }
    if let Some(ref ctx) = print_context {
        if let Ok(mut registry) = active_print_workers().lock() {
            if let Some(active) = registry.get_mut(&ctx.job_id) {
                active.pid = child_pid;
            }
        }
        print_breadcrumb(&format!(
            "isolated: register job={} pid={}",
            ctx.job_id, child_pid
        ));
    }

    let status_result = if let Some(ref ctx) = print_context {
        wait_print_worker(&mut child, ctx, progress_app.as_ref())
    } else {
        child.wait().map_err(|e| format!("Chờ print worker: {e}"))
    };
    unregister_print_context(print_context.as_ref(), child_pid);
    let status = status_result?;

    // Dọn job input (best-effort)
    let _ = std::fs::remove_file(&job_path);

    let out_str = match std::fs::read_to_string(&out_path) {
        Ok(s) => {
            let _ = std::fs::remove_file(&out_path);
            s
        }
        Err(_) => {
            // Worker chết (AV/driver) trước khi ghi result
            if !status.success() {
                print_breadcrumb(&format!(
                    "isolated: worker died without result code={:?}",
                    status.code()
                ));
                return Err(
                    "Tiến trình in bị dừng đột ngột (có thể do driver máy in). App vẫn an toàn — thử máy in khác hoặc Print to PDF."
                        .into(),
                );
            }
            return Err("Print worker không trả kết quả".into());
        }
    };

    let parsed: PrintWorkerResult =
        serde_json::from_str(&out_str).map_err(|e| format!("Parse result: {e}"))?;
    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "Print worker báo lỗi không rõ".into()));
    }
    print_breadcrumb("isolated: ok");
    Ok(parsed)
}

fn unregister_print_context(context: Option<&PrintRunContext>, pid: u32) {
    let Some(ctx) = context else { return };
    if let Ok(mut registry) = active_print_workers().lock() {
        let should_remove = registry
            .get(&ctx.job_id)
            .is_some_and(|active| pid == 0 || active.pid == pid);
        if should_remove {
            registry.remove(&ctx.job_id);
        }
    }
    let _ = std::fs::remove_file(&ctx.cancel_path);
    let _ = std::fs::remove_file(&ctx.progress_path);
}

fn wait_print_worker(
    child: &mut std::process::Child,
    context: &PrintRunContext,
    progress_app: Option<&tauri::AppHandle>,
) -> Result<std::process::ExitStatus, String> {
    let mut last_progress = String::new();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Theo dõi print worker: {e}"))?
        {
            emit_worker_progress(progress_app, &context.progress_path, &mut last_progress);
            return Ok(status);
        }
        emit_worker_progress(progress_app, &context.progress_path, &mut last_progress);
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
}

fn emit_worker_progress(
    progress_app: Option<&tauri::AppHandle>,
    progress_path: &Path,
    last_progress: &mut String,
) {
    use tauri::Emitter;
    let Some(app) = progress_app else { return };
    let Ok(raw) = std::fs::read_to_string(progress_path) else {
        return;
    };
    if raw == *last_progress {
        return;
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    *last_progress = raw;
    let _ = app.emit("print-progress", payload);
}

pub fn normalize_print_job_id(job_id: &str) -> String {
    let safe: String = job_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(80)
        .collect();
    if safe.is_empty() {
        format!(
            "print-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    } else {
        safe
    }
}

pub fn make_print_control_paths(job_id: &str) -> (String, String) {
    let safe = normalize_print_job_id(job_id);
    let base = std::env::temp_dir();
    (
        base.join(format!("prynx_print_{safe}.cancel"))
            .to_string_lossy()
            .into_owned(),
        base.join(format!("prynx_print_{safe}.progress.json"))
            .to_string_lossy()
            .into_owned(),
    )
}

/// Báo hủy cho đúng worker; nếu driver kẹt quá lâu thì kết thúc riêng worker đó sau thời gian ân hạn.
pub fn cancel_print_worker(job_id: &str) -> Result<bool, String> {
    let normalized = normalize_print_job_id(job_id);
    let active = active_print_workers()
        .lock()
        .map_err(|_| "Registry job in bị khóa lỗi".to_string())?
        .get(&normalized)
        .cloned();
    let Some(active) = active else {
        print_breadcrumb(&format!("cancel: job={} not active", normalized));
        return Ok(false);
    };
    std::fs::write(&active.cancel_path, b"cancel")
        .map_err(|e| format!("Không gửi được tín hiệu hủy job in: {e}"))?;
    print_breadcrumb(&format!(
        "cancel: signal job={} pid={}",
        normalized, active.pid
    ));

    if active.pid != 0 {
        let job_id_for_guard = normalized.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let still_running = active_print_workers()
                .lock()
                .ok()
                .and_then(|registry| registry.get(&job_id_for_guard).cloned())
                .is_some_and(|current| current.pid == active.pid);
            if still_running {
                print_breadcrumb(&format!(
                    "cancel: force stop job={} pid={}",
                    job_id_for_guard, active.pid
                ));
                kill_worker_pid(active.pid);
            }
        });
    }
    Ok(true)
}

fn kill_worker_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        active_print_workers, cancel_print_worker, make_print_control_paths,
        normalize_print_job_id, print_run_context, unique_worker_file_id, ActivePrintWorker,
        PrintWorkerJob,
    };
    use std::path::PathBuf;

    // PRINTWIN (audit 2026-08-13 §PRINTWIN.07): hai worker spawn sát nhau không được
    // ghi đè file job của nhau.
    #[test]
    fn worker_job_file_ids_khong_va_cham_khi_spawn_lien_tiep() {
        let ids: std::collections::HashSet<String> =
            (0..1000).map(|_| unique_worker_file_id()).collect();
        assert_eq!(ids.len(), 1000);
    }

    #[test]
    fn print_job_id_cannot_escape_temp_directory() {
        let normalized = normalize_print_job_id(r"..\..\bad/job:id");
        assert_eq!(normalized, "badjobid");
        let (cancel, progress) = make_print_control_paths(r"..\..\bad/job:id");
        assert!(PathBuf::from(cancel).starts_with(std::env::temp_dir()));
        assert!(PathBuf::from(progress).starts_with(std::env::temp_dir()));
    }

    #[test]
    fn utility_workers_are_not_registered_as_print_jobs() {
        assert!(print_run_context(&PrintWorkerJob::ListPrinters).is_none());
        assert!(print_run_context(&PrintWorkerJob::Geometry {
            printer_name: "Test".into(),
            orientation: None,
            devmode: None,
        })
        .is_none());
        assert!(print_run_context(&PrintWorkerJob::OpenProperties {
            printer_name: "Test".into(),
            current_devmode: None,
            advanced: false,
        })
        .is_none());
    }

    // Round-trip serde của protocol PrintDlg. Lưu ý §PRINTWIN.03: app hiện luôn gửi
    // owner_hwnd=0 (worker tự tạo owner cùng process); field vẫn phải giữ nguyên giá
    // trị qua serialize để tương thích job cũ.
    #[test]
    fn system_dialog_keeps_parent_window_handle_across_worker_protocol() {
        let job = PrintWorkerJob::PrintDlg {
            file_path: "C:\\Temp\\job.pdf".into(),
            from_page: Some(1),
            to_page: Some(1),
            pages: Some(vec![1]),
            scale_mode: Some("shrink".into()),
            auto_rotate: false,
            owner_hwnd: 12345,
        };
        let json = serde_json::to_string(&job).unwrap();
        let decoded: PrintWorkerJob = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            decoded,
            PrintWorkerJob::PrintDlg {
                owner_hwnd: 12345,
                pages: Some(ref pages),
                ..
            } if pages == &[1]
        ));
    }

    #[test]
    fn cancel_signal_targets_only_the_requested_job() {
        let job_id = normalize_print_job_id("print-target");
        let (cancel_path, _) = make_print_control_paths(&job_id);
        let cancel_path = PathBuf::from(cancel_path);
        let _ = std::fs::remove_file(&cancel_path);
        active_print_workers().lock().unwrap().insert(
            job_id.clone(),
            ActivePrintWorker {
                pid: 0,
                cancel_path: cancel_path.clone(),
            },
        );

        assert!(!cancel_print_worker("print-other").unwrap());
        assert!(!cancel_path.exists());
        assert!(cancel_print_worker(&job_id).unwrap());
        assert!(cancel_path.exists());

        active_print_workers().lock().unwrap().remove(&job_id);
        let _ = std::fs::remove_file(cancel_path);
    }
}
