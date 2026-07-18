//! Print worker out-of-process — driver GDI crash không kéo sập process UI.
//!
//! Parent ghi job JSON → spawn `PrynX.exe --prynx-print-job <in> --prynx-print-result <out>`
//! → worker chạy blocking GDI/PDFium → ghi result JSON → exit.
//! Nếu worker AV/exit bất thường, parent chỉ nhận lỗi, app chính còn sống.

use super::print::{print_breadcrumb, PrinterGeometry, PrinterInfo};
#[cfg(windows)]
use super::print::{
    get_printer_geometry_blocking, list_printers_blocking, open_printer_properties_blocking,
    parse_scale_mode_pub, print_direct_blocking, print_pdf_blocking, resolve_scale_mode_pub,
};
#[cfg(windows)]
use super::print_layout::{LayoutMode, PageSubset};
use std::sync::atomic::{AtomicU32, Ordering};

/// PID worker in đang chạy (0 = không có) — cancel_print_job kill process này.
static PRINT_WORKER_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PrintWorkerJob {
    ListPrinters,
    Geometry {
        printer_name: String,
        orientation: Option<String>,
        devmode: Option<Vec<u8>>,
    },
    /// UI thuộc tính driver — hwnd=0 (không modal parent); crash chỉ giết worker.
    OpenProperties {
        printer_name: String,
        current_devmode: Option<Vec<u8>>,
        advanced: bool,
    },
    PrintDirect {
        file_path: String,
        printer_name: String,
        from_page: Option<i32>,
        to_page: Option<i32>,
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
        scale_mode: Option<String>,
        auto_rotate: bool,
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

/// Entry point khi process được spawn với --prynx-print-job. Trả exit code.
pub fn run_print_worker(job_path: &str, result_path: &str) -> i32 {
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
    print_breadcrumb(&format!("worker: done code={code}"));
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
            file_path,
            printer_name,
            from_page,
            to_page,
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
                devmode,
                None, // no Tauri AppHandle in worker
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
            scale_mode,
            auto_rotate,
        } => {
            let mode = parse_scale_mode_pub(scale_mode.as_deref());
            match print_pdf_blocking(file_path, from_page, to_page, 0, mode, auto_rotate) {
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
    let op_name = match &job {
        PrintWorkerJob::ListPrinters => "list_printers",
        PrintWorkerJob::Geometry { .. } => "geometry",
        PrintWorkerJob::OpenProperties { .. } => "open_properties",
        PrintWorkerJob::PrintDirect { .. } => "print_direct",
        PrintWorkerJob::PrintDlg { .. } => "print_dlg",
    };
    print_breadcrumb(&format!("isolated: spawn op={op_name}"));

    let temp = std::env::temp_dir();
    let id = format!(
        "{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không spawn print worker: {e}"))?;
    PRINT_WORKER_PID.store(child.id(), Ordering::SeqCst);

    let status = child
        .wait()
        .map_err(|e| format!("Chờ print worker: {e}"))?;
    PRINT_WORKER_PID.store(0, Ordering::SeqCst);

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

/// Hủy job in worker (nếu đang chạy).
pub fn kill_print_worker() {
    let pid = PRINT_WORKER_PID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    print_breadcrumb(&format!("isolated: kill worker pid={pid}"));
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
