// In PDF native (Ctrl+P) — hộp thoại máy in Windows + render PDFium vào HDC máy in.
//
// Vì sao KHÔNG dùng window.print() của WebView2: nó chỉ in DOM (giao diện HTML),
// không biết gì về file PDF đang xem. Đường in đúng với stack Tauri là gọi thẳng
// GDI: PrintDlg (chọn máy in/số bản) -> nhận HDC -> với mỗi trang StartPage +
// FPDF_RenderPage(hdc, ...) + EndPage. Cho nét sắc & đúng khổ như Acrobat.
//
// FPDF_RenderPage(HDC) của pdfium-render bị gate sau feature `pdfium_use_win32`
// (đã bật ở Cargo.toml). Raw page/document handle của pdfium-render là pub(crate)
// nên KHÔNG lấy qua API safe — ta đi thẳng qua pdfium.bindings() (public) gọi raw FFI:
// FPDF_LoadDocument -> FPDF_LoadPage -> FPDF_RenderPage -> FPDF_ClosePage -> FPDF_CloseDocument.

use crate::pdf_engine::print_layout::{
    booklet_sheet_sides, chunk_pages, multipage_grid, poster_tiles, resolve_page_numbers,
    LayoutMode, PageSubset,
};
#[cfg(windows)]
#[derive(Clone, Debug)]
pub(crate) struct PrintJobControl {
    pub job_id: String,
    pub cancel_path: std::path::PathBuf,
    pub progress_path: std::path::PathBuf,
}

#[cfg(windows)]
impl PrintJobControl {
    fn is_cancelled(&self) -> bool {
        self.cancel_path.exists()
    }

    fn report(&self, stage: &str, current: u32, total: u32, spooler_job_id: Option<i32>) {
        let payload = serde_json::json!({
            "jobId": self.job_id,
            "stage": stage,
            "current": current,
            "total": total,
            "spoolerJobId": spooler_job_id,
        });
        // PERF (audit 2026-08-05 §PRINT.3/5): file rất nhỏ, chỉ ghi một lần mỗi tờ để
        // parent process chuyển tiếp progress mà vẫn giữ driver trong worker cách ly.
        let _ = std::fs::write(&self.progress_path, payload.to_string());
    }
}

/// Breadcrumb chẩn đoán crash Ctrl+P release → %APPDATA%\PrynX\logs\print_debug.log
pub fn print_breadcrumb(msg: &str) {
    log::info!("[PRINT] {}", msg);
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::Path::new(&appdata).join("PrynX").join("logs");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("print_debug.log"))
        {
            use std::io::Write;
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
            let _ = writeln!(f, "[{}] {}", now, msg);
        }
    }
}

#[tauri::command]
pub fn log_print_event(message: String) {
    print_breadcrumb(&format!("js: {}", message));
}

// ── API pub(crate) cho print_worker (out-of-process) ──
pub(crate) fn parse_scale_mode_pub(s: Option<&str>) -> ScaleMode {
    parse_scale_mode(s)
}
pub(crate) fn resolve_scale_mode_pub(s: Option<&str>, percent: Option<f64>) -> ScaleMode {
    resolve_scale_mode(s, percent)
}

#[cfg(test)]
fn for_each_print_page<E, F>(
    start_page: i32,
    end_page: i32,
    copies: i32,
    collate: bool,
    mut print_page: F,
) -> Result<(), E>
where
    F: FnMut(i32) -> Result<(), E>,
{
    if collate {
        for _copy in 0..copies {
            for page in start_page..=end_page {
                print_page(page)?;
            }
        }
    } else {
        for page in start_page..=end_page {
            for _copy in 0..copies {
                print_page(page)?;
            }
        }
    }
    Ok(())
}

// Chế độ tỉ lệ khi in, tương tự hộp thoại in của Acrobat:
//  - Actual: 100% (1 pt PDF = 1/72 inch trên giấy). Có thể tràn/cắt nếu trang > vùng in.
//  - Fit:    phóng/thu để vừa vùng in (cả to lên lẫn nhỏ đi).
//  - Shrink: chỉ THU khi trang lớn hơn vùng in; trang vừa/nhỏ giữ nguyên 100%.
// Mặc định (khi caller không truyền) = Shrink — an toàn cho in ấn: không tự phóng to,
// giữ 1:1 với mọi trang lọt khổ, chỉ thu tờ quá khổ để không mất nội dung.
//  - Custom(f): tỉ lệ do user nhập (f là phân số: 1.5 = 150%).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum ScaleMode {
    Actual,
    Fit,
    Shrink,
    Custom(f64),
}

const MAX_PRINT_COPIES: i32 = 999;

fn normalize_copies(copies: Option<i32>) -> i32 {
    copies.unwrap_or(1).clamp(1, MAX_PRINT_COPIES)
}

fn parse_scale_mode(s: Option<&str>) -> ScaleMode {
    match s {
        Some("actual") => ScaleMode::Actual,
        Some("fit") => ScaleMode::Fit,
        _ => ScaleMode::Shrink,
    }
}

// Resolver mới cho hộp thoại in hợp nhất: hỗ trợ thêm "custom" + phần trăm. Giữ
// parse_scale_mode cũ nguyên vẹn (print_pdf cũ + test cũ không đổi). percent tính
// theo % (100.0 = 100%); clamp [1%, 1000%] tránh giá trị vô lý làm tràn bộ nhớ render.
fn resolve_scale_mode(s: Option<&str>, percent: Option<f64>) -> ScaleMode {
    match s {
        Some("actual") => ScaleMode::Actual,
        Some("fit") => ScaleMode::Fit,
        Some("custom") => ScaleMode::Custom((percent.unwrap_or(100.0) / 100.0).clamp(0.01, 10.0)),
        _ => ScaleMode::Shrink,
    }
}

// Tỉ lệ để một trang page_w×page_h lọt vừa vùng in (giữ tỉ lệ). Guard chia-0.
fn fit_ratio(page_w: f64, page_h: f64, printable_w: f64, printable_h: f64) -> f64 {
    if page_w <= 0.0 || page_h <= 0.0 {
        return 1.0;
    }
    (printable_w / page_w).min(printable_h / page_h)
}

// Quyết định (scale, có xoay 90° hay không) từ kích thước ĐÃ HIỂN THỊ của trang
// (tức đã áp /Rotate). auto_rotate=true cho phép xoay để lọt khổ lớn hơn như Acrobat.
fn plan_scale_with_rotation_dimensions(
    disp_w: f64,
    disp_h: f64,
    rotated_w: f64,
    rotated_h: f64,
    printable_w: f64,
    printable_h: f64,
    mode: ScaleMode,
    auto_rotate: bool,
) -> (f64, bool) {
    let normal = fit_ratio(disp_w, disp_h, printable_w, printable_h);
    let rotated = fit_ratio(rotated_w, rotated_h, printable_w, printable_h);
    let (ratio, rotate_page) = if auto_rotate && rotated > normal * 1.001 {
        (rotated, true)
    } else {
        (normal, false)
    };
    let scale = match mode {
        ScaleMode::Actual => 1.0,
        ScaleMode::Fit => ratio,
        ScaleMode::Shrink => ratio.min(1.0),
        ScaleMode::Custom(f) => f,
    };
    (scale, rotate_page)
}

#[cfg(test)]
fn plan_scale(
    disp_w: f64,
    disp_h: f64,
    printable_w: f64,
    printable_h: f64,
    mode: ScaleMode,
    auto_rotate: bool,
) -> (f64, bool) {
    plan_scale_with_rotation_dimensions(
        disp_w,
        disp_h,
        disp_h,
        disp_w,
        printable_w,
        printable_h,
        mode,
        auto_rotate,
    )
}
#[cfg(windows)]
fn remove_owned_print_temp(path: &str) {
    let candidate = std::path::Path::new(path);
    let is_owned_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("prynx_print_") && name.ends_with(".pdf"))
        .unwrap_or(false);
    if !is_owned_name {
        return;
    }

    let Some(parent) = candidate.parent() else {
        return;
    };
    let Ok(temp_dir) = std::env::temp_dir().canonicalize() else {
        return;
    };
    let Ok(parent) = parent.canonicalize() else {
        return;
    };
    if parent == temp_dir {
        let _ = std::fs::remove_file(candidate);
    }
}

// Đổi chuỗi orientation từ JS → giá trị dmOrientation của DEVMODE.
//  "portrait"  → 1 (DMORIENT_PORTRAIT)
//  "landscape" → 2 (DMORIENT_LANDSCAPE)
//  "auto"/None/khác → None (không ép — dùng mặc định máy in).
#[cfg(windows)]
fn orientation_to_devmode(s: Option<&str>) -> Option<i16> {
    match s {
        Some("portrait") => Some(1),
        Some("landscape") => Some(2),
        _ => None,
    }
}

// Chuỗi UTF-16 NUL-terminated cho PCWSTR.
#[cfg(windows)]
fn to_wide_nul(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// PWSTR (con trỏ u16 NUL-terminated) → String. Đọc tới NUL.
#[cfg(windows)]
unsafe fn pwstr_to_string(p: windows::core::PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *p.0.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(p.0, len);
    String::from_utf16_lossy(slice)
}

// Dựng buffer DEVMODE cho máy in + orientation (nếu ép). Trả Vec<u8> (PHẢI giữ sống
// tới sau CreateDCW vì con trỏ trỏ vào nó). None = dùng mặc định máy in (không ép).
//
// AN TOÀN FFI (hazard #1): DocumentPropertiesW lần 1 trả BYTE COUNT thật (gồm
// dmDriverExtra dữ liệu riêng driver) — PHẢI cấp đúng số byte đó, KHÔNG size_of::<DEVMODEW>().
// Undersize = tràn bộ nhớ/crash. Hai-lần-gọi: DM_OUT_BUFFER lấy default → sửa field →
// DM_IN_BUFFER|DM_OUT_BUFFER re-validate.
#[cfg(windows)]
fn valid_devmode_bytes(buf: &[u8]) -> bool {
    use windows::Win32::Graphics::Gdi::DEVMODEW;
    if buf.len() < std::mem::size_of::<DEVMODEW>() {
        return false;
    }
    let dm = unsafe { &*(buf.as_ptr() as *const DEVMODEW) };
    let declared = dm.dmSize as usize + dm.dmDriverExtra as usize;
    dm.dmSize as usize >= std::mem::size_of::<DEVMODEW>() && declared <= buf.len()
}

#[cfg(windows)]
fn build_devmode(
    printer_name: &str,
    orientation: Option<&str>,
    current_devmode: Option<&[u8]>,
) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{DEVMODEW, DM_IN_BUFFER, DM_ORIENTATION, DM_OUT_BUFFER};
    use windows::Win32::Graphics::Printing::{ClosePrinter, DocumentPropertiesW, OpenPrinterW};

    let dm_orient = orientation_to_devmode(orientation);
    if dm_orient.is_none() && current_devmode.is_none() {
        return None;
    }

    let name_w = to_wide_nul(printer_name);
    let name_pcwstr = PCWSTR(name_w.as_ptr());

    unsafe {
        let mut hprinter = windows::Win32::Graphics::Printing::PRINTER_HANDLE::default();
        if OpenPrinterW(name_pcwstr, &mut hprinter, None).is_err() {
            return None;
        }

        // Lần 1: lấy byte count cần cấp (gồm dmDriverExtra).
        let needed = DocumentPropertiesW(None, hprinter, name_pcwstr, None, None, 0);
        if needed <= 0 {
            let _ = ClosePrinter(hprinter);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];

        // Lần 2: điền DEVMODE mặc định của máy in.
        let out_ptr = buf.as_mut_ptr() as *mut DEVMODEW;
        let r = DocumentPropertiesW(
            None,
            hprinter,
            name_pcwstr,
            Some(out_ptr),
            None,
            DM_OUT_BUFFER.0,
        );
        if r < 0 {
            let _ = ClosePrinter(hprinter);
            return None;
        }

        if let Some(input) = current_devmode.filter(|input| valid_devmode_bytes(input)) {
            let input_dm = &*(input.as_ptr() as *const DEVMODEW);
            let declared = input_dm.dmSize as usize + input_dm.dmDriverExtra as usize;
            let copy_len = declared.min(buf.len());
            buf[..copy_len].copy_from_slice(&input[..copy_len]);
        }

        // Ép orientation nếu UI chính yêu cầu; sau đó re-validate toàn bộ qua driver.
        if let Some(dm_orient) = dm_orient {
            let dm = &mut *out_ptr;
            dm.Anonymous1.Anonymous1.dmOrientation = dm_orient;
            dm.dmFields |= DM_ORIENTATION;
        }
        let r2 = DocumentPropertiesW(
            None,
            hprinter,
            name_pcwstr,
            Some(out_ptr),
            Some(out_ptr as *const DEVMODEW),
            (DM_IN_BUFFER | DM_OUT_BUFFER).0,
        );
        let _ = ClosePrinter(hprinter);
        if r2 < 0 {
            return None;
        }
        Some(buf)
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn open_printer_properties(
    _window: tauri::WebviewWindow,
    printer_name: String,
    current_devmode: Option<Vec<u8>>,
    advanced: Option<bool>,
) -> Result<Option<Vec<u8>>, String> {
    print_breadcrumb(&format!(
        "open_printer_properties: enter isolated printer={:?} advanced={:?}",
        printer_name, advanced
    ));
    // Out-of-process: DocumentPropertiesW nạp UI driver — AV chỉ giết worker.
    tauri::async_runtime::spawn_blocking(move || {
        let job = crate::pdf_engine::print_worker::PrintWorkerJob::OpenProperties {
            printer_name,
            current_devmode,
            advanced: advanced.unwrap_or(false),
        };
        match crate::pdf_engine::print_worker::run_isolated(job) {
            Ok(res) => {
                print_breadcrumb("open_printer_properties: leave");
                // None = user cancel; Some = DEVMODE mới — cả hai đều ok:true
                Ok(res.devmode)
            }
            Err(e) => {
                print_breadcrumb(&format!("open_printer_properties: err {e}"));
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Luồng thuộc tính máy in bị lỗi: {e}"))?
}

#[cfg(windows)]
pub(crate) fn open_printer_properties_blocking(
    owner_hwnd: isize,
    printer_name: String,
    current_devmode: Option<Vec<u8>>,
    advanced: bool,
) -> Result<Option<Vec<u8>>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{DEVMODEW, DM_IN_BUFFER, DM_IN_PROMPT, DM_OUT_BUFFER};
    use windows::Win32::Graphics::Printing::{
        AdvancedDocumentPropertiesW, ClosePrinter, DocumentPropertiesW, OpenPrinterW,
    };

    if printer_name.trim().is_empty() {
        return Err("Chưa chọn máy in".into());
    }

    let name_w = to_wide_nul(&printer_name);
    let name_pcwstr = PCWSTR(name_w.as_ptr());
    unsafe {
        let mut hprinter = windows::Win32::Graphics::Printing::PRINTER_HANDLE::default();
        OpenPrinterW(name_pcwstr, &mut hprinter, None)
            .map_err(|e| format!("Không mở được máy in {printer_name}: {e}"))?;

        let needed = DocumentPropertiesW(None, hprinter, name_pcwstr, None, None, 0);
        if needed <= 0 {
            let _ = ClosePrinter(hprinter);
            return Err("Driver không cung cấp DEVMODE hợp lệ".into());
        }

        let mut buf = vec![0u8; needed as usize];
        let out_ptr = buf.as_mut_ptr() as *mut DEVMODEW;
        let default_result = DocumentPropertiesW(
            None,
            hprinter,
            name_pcwstr,
            Some(out_ptr),
            None,
            DM_OUT_BUFFER.0,
        );
        if default_result < 0 {
            let _ = ClosePrinter(hprinter);
            return Err("Không đọc được cấu hình mặc định của máy in".into());
        }

        if let Some(input) = current_devmode
            .as_deref()
            .filter(|input| valid_devmode_bytes(input))
        {
            let input_dm = &*(input.as_ptr() as *const DEVMODEW);
            let declared = input_dm.dmSize as usize + input_dm.dmDriverExtra as usize;
            let copy_len = declared.min(buf.len());
            buf[..copy_len].copy_from_slice(&input[..copy_len]);
        }

        let hwnd = HWND(owner_hwnd as *mut std::ffi::c_void);
        let result = if advanced {
            AdvancedDocumentPropertiesW(
                hwnd,
                hprinter,
                name_pcwstr,
                Some(out_ptr),
                Some(out_ptr as *const DEVMODEW),
            )
        } else {
            DocumentPropertiesW(
                Some(hwnd),
                hprinter,
                name_pcwstr,
                Some(out_ptr),
                Some(out_ptr as *const DEVMODEW),
                (DM_IN_BUFFER | DM_OUT_BUFFER | DM_IN_PROMPT).0,
            )
        };
        let _ = ClosePrinter(hprinter);

        if result < 0 {
            Err("Driver máy in không mở được trang thuộc tính".into())
        } else if result == 0 || (!advanced && result == 2) {
            Ok(None)
        } else {
            Ok(Some(buf))
        }
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn print_pdf(
    window: tauri::WebviewWindow,
    file_path: String,
    from_page: Option<i32>,
    to_page: Option<i32>,
    pages: Option<Vec<i32>>,
    delete_after: Option<bool>,
    scale_mode: Option<String>,
    auto_rotate: Option<bool>,
) -> Result<bool, String> {
    let owner_hwnd = window
        .hwnd()
        .map_err(|e| format!("Không lấy được cửa sổ PrynX: {e}"))?
        .0 as isize;
    // Mặc định: Shrink-to-fit + KHÔNG auto-rotate. An toàn cho tab bình bài/CNC —
    // giữ 1:1 với tờ lọt khổ, không tự xoay làm lệch định hướng đã thiết kế.
    let auto_rotate = auto_rotate.unwrap_or(false);
    let mode_for_fallback = parse_scale_mode(scale_mode.as_deref());
    print_breadcrumb("print_pdf: enter (isolated PrintDlg)");
    // Out-of-process: driver AV không kéo sập UI. hwnd owner = 0 trong worker.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let job = crate::pdf_engine::print_worker::PrintWorkerJob::PrintDlg {
            file_path: file_path.clone(),
            from_page,
            to_page,
            pages: pages.clone(),
            scale_mode,
            auto_rotate,
            // UIUX (audit 2026-08-05 §PRINT.4): worker vẫn cách ly driver nhưng dialog
            // Windows được gắn với cửa sổ PrynX, không còn bật khuất phía sau.
            owner_hwnd,
        };
        let r = crate::pdf_engine::print_worker::run_isolated(job)
            .map(|res| res.printed.unwrap_or(false));
        if delete_after.unwrap_or(false) {
            remove_owned_print_temp(&file_path);
        }
        // Fallback in-process nếu spawn worker fail (path/exe lạ)
        match r {
            Ok(v) => Ok(v),
            Err(e) if e.contains("Không spawn print worker") => {
                print_breadcrumb("print_pdf: fallback in-process");
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    print_pdf_blocking(
                        file_path.clone(),
                        from_page,
                        to_page,
                        pages,
                        owner_hwnd,
                        mode_for_fallback,
                        auto_rotate,
                    )
                }))
                .unwrap_or_else(|_| Err("Lệnh in bị lỗi hệ thống (driver/GDI)".into()))
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("Luồng in bị lỗi: {e}"))?;
    print_breadcrumb("print_pdf: leave");
    result
}

#[cfg(windows)]
pub(crate) fn print_pdf_blocking(
    file_path: String,
    from_page: Option<i32>,
    to_page: Option<i32>,
    pages: Option<Vec<i32>>,
    owner_hwnd: isize,
    mode: ScaleMode,
    auto_rotate: bool,
) -> Result<bool, String> {
    use windows::core::Free;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::DeleteDC;
    use windows::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, PrintDlgW, PD_COLLATE, PD_NOSELECTION, PD_RETURNDC, PRINTDLGW,
    };

    // Bit "user đã chọn khoảng trang" trong PRINTDLG.Flags (PD_PAGENUMS).
    const PD_PAGENUMS_BIT: u32 = 0x02;

    if file_path.trim().is_empty() {
        return Err("Đường dẫn PDF trống".into());
    }

    // ── 1) Mở tài liệu qua raw FFI để lấy số trang (cần cho min/max của hộp thoại) ──
    let pdfium = crate::ensure_pdfium()?;
    let b = pdfium.bindings();

    let doc = {
        let _guard = crate::lock_mutex(&crate::LOAD_LOCK);
        b.FPDF_LoadDocument(&file_path, None)
    };
    if doc.is_null() {
        return Err(format!("Không mở được PDF: {}", file_path));
    }

    // Từ đây mọi nhánh thoát PHẢI đóng doc. Dùng closure cleanup thủ công.
    let page_count = b.FPDF_GetPageCount(doc);
    if page_count <= 0 {
        b.FPDF_CloseDocument(doc);
        return Err("PDF không có trang nào".into());
    }

    // ── 2) Hộp thoại in Windows (chọn máy in, số bản, khổ giấy) ──
    // KHÔNG dùng PD_USEDEVMODECOPIESANDCOLLATE: ta tự loop số bản để copies luôn đúng
    // trên mọi driver (driver không hỗ trợ collate vẫn ra đủ bản).
    let mut pd = PRINTDLGW::default();
    pd.lStructSize = std::mem::size_of::<PRINTDLGW>() as u32;
    pd.hwndOwner = HWND(owner_hwnd as *mut std::ffi::c_void);
    pd.Flags = PD_RETURNDC | PD_NOSELECTION;
    pd.nMinPage = 1;
    pd.nMaxPage = page_count.min(0xFFFF) as u16;
    pd.nFromPage = 1;
    pd.nToPage = pd.nMaxPage;
    pd.nCopies = 1;

    let dlg_ok = unsafe { PrintDlgW(&mut pd) };
    if !dlg_ok.as_bool() {
        // 0 = user bấm Cancel; khác 0 = lỗi thật.
        let err = unsafe { CommDlgExtendedError() };
        unsafe {
            pd.hDevMode.free();
            pd.hDevNames.free();
        }
        b.FPDF_CloseDocument(doc);
        if err.0 == 0 {
            return Ok(false); // user hủy — im lặng
        }
        return Err(format!("PrintDlg lỗi: 0x{:X}", err.0));
    }

    let hdc = pd.hDC;
    // Giải phóng handle do hộp thoại cấp phát (tránh rò rỉ). Free::free() no-op khi invalid.
    unsafe {
        pd.hDevMode.free();
        pd.hDevNames.free();
    }

    if hdc.is_invalid() {
        b.FPDF_CloseDocument(doc);
        return Err("Không nhận được HDC máy in".into());
    }

    // ── 3) Xác định khoảng trang dự phòng ──
    // Danh sách `pages` (nếu có) được run_print_job ưu tiên; from/to chỉ còn làm
    // fallback cho đường cũ hoặc lựa chọn trực tiếp trong hộp thoại Windows.
    let (start_pg, end_pg): (i32, i32) = if let (Some(f), Some(t)) = (from_page, to_page) {
        (f.max(1), t.min(page_count))
    } else if (pd.Flags.0 & PD_PAGENUMS_BIT) != 0 {
        (pd.nFromPage as i32, (pd.nToPage as i32).min(page_count))
    } else {
        (1, page_count)
    };
    if pages.is_none() && start_pg > end_pg {
        unsafe {
            let _ = DeleteDC(hdc);
        }
        b.FPDF_CloseDocument(doc);
        return Err("Khoảng trang không hợp lệ".into());
    }

    let copies = normalize_copies(Some(pd.nCopies as i32));
    let collate = pd.Flags.contains(PD_COLLATE);

    let doc_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("PDF")
        .to_string();

    // ── 4) Chạy job in (chung với print_pdf_direct) → đóng HDC + doc ──
    let opts = PrintJobOptions {
        start_pg,
        end_pg,
        pages,
        page_count,
        copies,
        collate,
        mode,
        auto_rotate,
        grayscale: false,
        print_annotations: true,
        ..PrintJobOptions::default()
    };
    let result = run_print_job(b, doc, hdc, opts, &doc_name, None, None, None);
    unsafe {
        let _ = DeleteDC(hdc);
    }
    b.FPDF_CloseDocument(doc);
    result.map(|_| true)
}

// (PrintJobOptions defined below run_print_job helpers — kept after print_pdf_blocking)

/// Tuỳ chọn in mở rộng (subset / reverse / multiple / booklet / poster).
#[derive(Clone, Debug)]
struct PrintJobOptions {
    start_pg: i32,
    end_pg: i32,
    pages: Option<Vec<i32>>,
    page_count: i32,
    copies: i32,
    collate: bool,
    mode: ScaleMode,
    auto_rotate: bool,
    grayscale: bool,
    print_annotations: bool,
    reverse: bool,
    subset: PageSubset,
    layout: LayoutMode,
    pages_per_sheet: u32,
    poster_cols: u32,
    poster_rows: u32,
}

impl Default for PrintJobOptions {
    fn default() -> Self {
        Self {
            start_pg: 1,
            end_pg: 1,
            pages: None,
            page_count: 1,
            copies: 1,
            collate: true,
            mode: ScaleMode::Shrink,
            auto_rotate: false,
            grayscale: false,
            print_annotations: true,
            reverse: false,
            subset: PageSubset::All,
            layout: LayoutMode::Size,
            pages_per_sheet: 2,
            poster_cols: 2,
            poster_rows: 2,
        }
    }
}

// Chạy lệnh in vào một HDC máy in ĐÃ CÓ (dùng chung cho print_pdf qua PrintDlgW và
// print_pdf_direct qua CreateDCW). KHÔNG sở hữu hdc/doc — caller đóng cả hai ở mọi nhánh.
// control: cancel/progress qua file rất nhỏ để worker vẫn cách ly driver khỏi process UI.
#[cfg(windows)]
fn run_print_job(
    b: &dyn pdfium_render::prelude::PdfiumLibraryBindings,
    doc: pdfium_render::prelude::FPDF_DOCUMENT,
    hdc: windows::Win32::Graphics::Gdi::HDC,
    opts: PrintJobOptions,
    doc_name: &str,
    output_path: Option<&str>,
    printer_name: Option<&str>,
    control: Option<PrintJobControl>,
) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{GetDeviceCaps, HORZRES, LOGPIXELSX, LOGPIXELSY, VERTRES};
    use windows::Win32::Storage::Xps::{AbortDoc, EndDoc, EndPage, StartDocW, StartPage, DOCINFOW};

    if control.as_ref().is_some_and(PrintJobControl::is_cancelled) {
        if let Some(ref ctl) = control {
            ctl.report("cancelled", 0, 0, None);
        }
        return Err("Đã hủy lệnh in".into());
    }

    // UIUX (audit 2026-08-11 §PRINTRANGE.1): validate danh sách explicit trước
    // StartDocW để input lỗi không tạo một job rồi mới AbortDoc trong spooler.
    let pages = resolve_page_numbers(
        opts.pages.as_deref(),
        opts.start_pg,
        opts.end_pg,
        opts.page_count,
        opts.subset,
        opts.reverse,
    )?;

    const FPDF_ANNOT: i32 = 0x01;
    const FPDF_GRAYSCALE: i32 = 0x08;
    const FPDF_PRINTING: i32 = 0x800;
    let mut render_flags = FPDF_PRINTING;
    if opts.print_annotations {
        render_flags |= FPDF_ANNOT;
    }
    if opts.grayscale {
        render_flags |= FPDF_GRAYSCALE;
    }

    let dpi_x = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSX) } as f64;
    let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) } as f64;
    let printable_w = unsafe { GetDeviceCaps(Some(hdc), HORZRES) } as f64;
    let printable_h = unsafe { GetDeviceCaps(Some(hdc), VERTRES) } as f64;
    if dpi_x <= 0.0 || dpi_y <= 0.0 || printable_w <= 0.0 || printable_h <= 0.0 {
        return Err("Máy in không cung cấp vùng in hoặc độ phân giải hợp lệ".into());
    }

    let _render_guard = crate::lock_mutex(&crate::RENDER_LOCK);

    let doc_name_w: Vec<u16> = doc_name.encode_utf16().chain(std::iter::once(0)).collect();
    let output_path_w = output_path.map(to_wide_nul);
    let mut di = DOCINFOW::default();
    di.cbSize = std::mem::size_of::<DOCINFOW>() as i32;
    di.lpszDocName = PCWSTR(doc_name_w.as_ptr());
    if let Some(ref path) = output_path_w {
        // FIX (audit 2026-08-05 §PRINT.1): PORTPROMPT/file printer cần lpszOutput;
        // nếu để NULL, spooler có thể tạo rồi tự hủy job mà không sinh file.
        di.lpszOutput = PCWSTR(path.as_ptr());
    }

    let spooler_job_id = unsafe { StartDocW(hdc, &di) };
    if spooler_job_id <= 0 {
        if let Some(ref ctl) = control {
            ctl.report("start_doc_failed", 0, 0, None);
        }
        return Err("StartDoc thất bại (không bắt đầu được lệnh in)".into());
    }
    print_breadcrumb(&format!(
        "job={} stage=start_doc spooler_job_id={}",
        control
            .as_ref()
            .map(|c| c.job_id.as_str())
            .unwrap_or("legacy"),
        spooler_job_id
    ));

    // Render one logical PDF page into a rectangle on the current sheet.
    let render_page_in_rect =
        |pg: i32, cell_x: i32, cell_y: i32, cell_w: f64, cell_h: f64| -> Result<(), String> {
            if pg <= 0 {
                return Ok(()); // blank slot (booklet pad)
            }
            let idx = pg - 1;
            let mut w_pt: f64 = 0.0;
            let mut h_pt: f64 = 0.0;
            let ok = b.FPDF_GetPageSizeByIndex(doc, idx, &mut w_pt, &mut h_pt);
            if ok == 0 || w_pt <= 0.0 || h_pt <= 0.0 {
                return Err(format!("Không đọc được kích thước trang {}", pg));
            }
            let page = b.FPDF_LoadPage(doc, idx);
            if page.is_null() {
                return Err(format!("Không load được trang {}", pg));
            }
            let page_w_px = w_pt / 72.0 * dpi_x;
            let page_h_px = h_pt / 72.0 * dpi_y;
            let rotated_w_px = h_pt / 72.0 * dpi_x;
            let rotated_h_px = w_pt / 72.0 * dpi_y;
            let (scale, rotate_page) = plan_scale_with_rotation_dimensions(
                page_w_px,
                page_h_px,
                rotated_w_px,
                rotated_h_px,
                cell_w,
                cell_h,
                opts.mode,
                opts.auto_rotate,
            );
            let (effective_w, effective_h, rotation) = if rotate_page {
                (rotated_w_px, rotated_h_px, 1)
            } else {
                (page_w_px, page_h_px, 0)
            };
            let draw_w = (effective_w * scale).round() as i32;
            let draw_h = (effective_h * scale).round() as i32;
            let off_x = cell_x + ((cell_w - draw_w as f64) / 2.0).round() as i32;
            let off_y = cell_y + ((cell_h - draw_h as f64) / 2.0).round() as i32;
            b.FPDF_RenderPage(
                hdc,
                page,
                off_x,
                off_y,
                draw_w,
                draw_h,
                rotation,
                render_flags,
            );
            b.FPDF_ClosePage(page);
            Ok(())
        };

    let start_sheet = || -> Result<(), String> {
        if unsafe { StartPage(hdc) } <= 0 {
            Err("StartPage thất bại".into())
        } else {
            Ok(())
        }
    };
    let end_sheet = || -> Result<(), String> {
        if unsafe { EndPage(hdc) } <= 0 {
            Err("EndPage thất bại".into())
        } else {
            Ok(())
        }
    };
    let check_cancel = || -> Result<(), String> {
        if control.as_ref().is_some_and(PrintJobControl::is_cancelled) {
            Err("Đã hủy lệnh in".into())
        } else {
            Ok(())
        }
    };

    // Build list of "sheet actions" then expand by copies/collate.
    // Each sheet is a list of (page, cell_x, cell_y, cell_w, cell_h) or poster tile.
    enum SheetPlan {
        Cells(Vec<(i32, i32, i32, f64, f64)>),
        Poster {
            page: i32,
            col: u32,
            row: u32,
            cols: u32,
            rows: u32,
        },
    }

    let mut sheet_plans: Vec<SheetPlan> = Vec::new();

    match opts.layout {
        LayoutMode::Size => {
            for &pg in &pages {
                sheet_plans.push(SheetPlan::Cells(vec![(pg, 0, 0, printable_w, printable_h)]));
            }
        }
        LayoutMode::Multiple => {
            let pps = opts.pages_per_sheet.max(1);
            let (cols, rows) = multipage_grid(pps);
            let cell_w = printable_w / cols as f64;
            let cell_h = printable_h / rows as f64;
            for chunk in chunk_pages(&pages, pps as usize) {
                let mut cells = Vec::new();
                for (i, &pg) in chunk.iter().enumerate() {
                    let c = (i as u32) % cols;
                    let r = (i as u32) / cols;
                    cells.push((
                        pg,
                        (c as f64 * cell_w).round() as i32,
                        (r as f64 * cell_h).round() as i32,
                        cell_w,
                        cell_h,
                    ));
                }
                sheet_plans.push(SheetPlan::Cells(cells));
            }
        }
        LayoutMode::Booklet => {
            // 2-up landscape pairs; use half-width cells
            let cell_w = printable_w / 2.0;
            for (left, right) in booklet_sheet_sides(&pages) {
                sheet_plans.push(SheetPlan::Cells(vec![
                    (left, 0, 0, cell_w, printable_h),
                    (right, cell_w.round() as i32, 0, cell_w, printable_h),
                ]));
            }
        }
        LayoutMode::Poster => {
            let cols = opts.poster_cols.max(1);
            let rows = opts.poster_rows.max(1);
            for &pg in &pages {
                for (c, r) in poster_tiles(cols, rows) {
                    sheet_plans.push(SheetPlan::Poster {
                        page: pg,
                        col: c,
                        row: r,
                        cols,
                        rows,
                    });
                }
            }
        }
    }

    if sheet_plans.is_empty() {
        unsafe {
            let _ = AbortDoc(hdc);
        }
        return Err("Không tạo được tờ in".into());
    }

    // Expand copies (collate: repeat full set; else repeat each sheet)
    let mut final_sheets: Vec<&SheetPlan> = Vec::new();
    if opts.collate {
        for _ in 0..opts.copies {
            for s in &sheet_plans {
                final_sheets.push(s);
            }
        }
    } else {
        for s in &sheet_plans {
            for _ in 0..opts.copies {
                final_sheets.push(s);
            }
        }
    }

    let total = final_sheets.len() as u32;
    if let Some(ref ctl) = control {
        ctl.report("rendering", 0, total, Some(spooler_job_id));
    }
    let render_result: Result<(), String> = (|| {
        for (i, plan) in final_sheets.iter().enumerate() {
            check_cancel()?;
            if let Some(ref ctl) = control {
                ctl.report("rendering", (i as u32) + 1, total, Some(spooler_job_id));
            }
            start_sheet()?;
            match plan {
                SheetPlan::Cells(cells) => {
                    for &(pg, x, y, w, h) in cells {
                        render_page_in_rect(pg, x, y, w, h)?;
                    }
                }
                SheetPlan::Poster {
                    page,
                    col,
                    row,
                    cols,
                    rows,
                } => {
                    // Render full page scaled to (cols*paper) × (rows*paper), offset so tile is on sheet.
                    let pg = *page;
                    if pg <= 0 {
                        end_sheet()?;
                        continue;
                    }
                    let idx = pg - 1;
                    let mut w_pt: f64 = 0.0;
                    let mut h_pt: f64 = 0.0;
                    let ok = b.FPDF_GetPageSizeByIndex(doc, idx, &mut w_pt, &mut h_pt);
                    if ok == 0 || w_pt <= 0.0 || h_pt <= 0.0 {
                        return Err(format!("Không đọc được kích thước trang {}", pg));
                    }
                    let page_h = b.FPDF_LoadPage(doc, idx);
                    if page_h.is_null() {
                        return Err(format!("Không load được trang {}", pg));
                    }
                    let full_w = printable_w * (*cols as f64);
                    let full_h = printable_h * (*rows as f64);
                    let page_w_px = w_pt / 72.0 * dpi_x;
                    let page_h_px = h_pt / 72.0 * dpi_y;
                    let scale = (full_w / page_w_px).min(full_h / page_h_px);
                    let draw_w = (page_w_px * scale).round() as i32;
                    let draw_h = (page_h_px * scale).round() as i32;
                    // Center the enlarged page on the multi-tile canvas, then shift by tile.
                    let base_x = ((full_w - draw_w as f64) / 2.0).round() as i32
                        - (*col as f64 * printable_w).round() as i32;
                    let base_y = ((full_h - draw_h as f64) / 2.0).round() as i32
                        - (*row as f64 * printable_h).round() as i32;
                    b.FPDF_RenderPage(hdc, page_h, base_x, base_y, draw_w, draw_h, 0, render_flags);
                    b.FPDF_ClosePage(page_h);
                }
            }
            end_sheet()?;
        }
        Ok(())
    })();

    if let Err(e) = render_result {
        unsafe {
            let _ = AbortDoc(hdc);
        }
        if let Some(ref ctl) = control {
            let stage = if ctl.is_cancelled() {
                "cancelled"
            } else {
                "render_failed"
            };
            ctl.report(stage, 0, total, Some(spooler_job_id));
        }
        print_breadcrumb(&format!(
            "job={} stage=abort_doc error={}",
            control
                .as_ref()
                .map(|c| c.job_id.as_str())
                .unwrap_or("legacy"),
            e
        ));
        return Err(e);
    }

    let end = unsafe { EndDoc(hdc) };
    if end <= 0 {
        if let Some(ref ctl) = control {
            ctl.report("end_doc_failed", total, total, Some(spooler_job_id));
        }
        return Err("EndDoc thất bại (lệnh in không hoàn tất)".into());
    }
    if let Some(printer) = printer_name {
        if let Some(status) = query_spooler_job_status(printer, spooler_job_id as u32) {
            print_breadcrumb(&format!(
                "job={} stage=spooler_status id={} status=0x{:X} pages={}/{} text={}",
                control
                    .as_ref()
                    .map(|c| c.job_id.as_str())
                    .unwrap_or("legacy"),
                spooler_job_id,
                status.flags,
                status.pages_printed,
                status.total_pages,
                status.text
            ));
            if status.flags & windows::Win32::Graphics::Printing::JOB_STATUS_ERROR != 0 {
                if let Some(ref ctl) = control {
                    ctl.report("spooler_error", total, total, Some(spooler_job_id));
                }
                return Err(format!(
                    "Windows Print Spooler báo lỗi cho job {}: {}",
                    spooler_job_id, status.text
                ));
            }
        } else {
            // Job có thể đã ra khỏi queue rất nhanh (đã in xong); ghi rõ để chẩn đoán,
            // không biến trạng thái bình thường này thành lỗi giả.
            print_breadcrumb(&format!(
                "job={} stage=spooler_status id={} no_longer_queued",
                control
                    .as_ref()
                    .map(|c| c.job_id.as_str())
                    .unwrap_or("legacy"),
                spooler_job_id
            ));
        }
    }
    if let Some(ref ctl) = control {
        ctl.report("completed", total, total, Some(spooler_job_id));
    }
    print_breadcrumb(&format!(
        "job={} stage=end_doc spooler_job_id={}",
        control
            .as_ref()
            .map(|c| c.job_id.as_str())
            .unwrap_or("legacy"),
        spooler_job_id
    ));
    Ok(())
}

#[cfg(windows)]
struct SpoolerJobStatus {
    flags: u32,
    total_pages: u32,
    pages_printed: u32,
    text: String,
}

#[cfg(windows)]
fn query_spooler_job_status(printer_name: &str, job_id: u32) -> Option<SpoolerJobStatus> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Printing::{ClosePrinter, GetJobW, OpenPrinterW, JOB_INFO_1W};

    let printer_w = to_wide_nul(printer_name);
    let mut handle = Default::default();
    unsafe {
        OpenPrinterW(PCWSTR(printer_w.as_ptr()), &mut handle, None).ok()?;
        let mut needed = 0u32;
        let _ = GetJobW(handle, job_id, 1, None, &mut needed);
        if needed == 0 {
            let _ = ClosePrinter(handle);
            return None;
        }
        let mut buffer = vec![0u8; needed as usize];
        let ok = GetJobW(handle, job_id, 1, Some(&mut buffer), &mut needed).as_bool();
        let _ = ClosePrinter(handle);
        if !ok {
            return None;
        }
        let info = &*(buffer.as_ptr() as *const JOB_INFO_1W);
        Some(SpoolerJobStatus {
            flags: info.Status,
            total_pages: info.TotalPages,
            pages_printed: info.PagesPrinted,
            text: pwstr_to_string(info.pStatus),
        })
    }
}

// In THẲNG vào máy in đã chọn (hộp thoại in kiểu Acrobat), KHÔNG bung PrintDlgW.
// JS đã lo hết UI (máy in / số bản / khoảng trang / tỉ lệ / orientation) rồi truyền
// xuống. HDC tạo bằng CreateDCW từ tên máy in + DEVMODE (orientation). hdc invalid →
// Err để JS tự fallback về print_pdf (PrintDlgW). Xem [[nativePrint]] phía frontend.
#[cfg(windows)]
#[tauri::command]
pub async fn print_pdf_direct(
    app: tauri::AppHandle,
    job_id: String,
    file_path: String,
    printer_name: String,
    output_path: Option<String>,
    from_page: Option<i32>,
    to_page: Option<i32>,
    pages: Option<Vec<i32>>,
    copies: Option<i32>,
    collate: Option<bool>,
    delete_after: Option<bool>,
    scale_mode: Option<String>,
    scale_percent: Option<f64>,
    orientation: Option<String>,
    auto_rotate: Option<bool>,
    grayscale: Option<bool>,
    print_annotations: Option<bool>,
    devmode: Option<Vec<u8>>,
    reverse: Option<bool>,
    page_subset: Option<String>,
    layout_mode: Option<String>,
    pages_per_sheet: Option<u32>,
    poster_cols: Option<u32>,
    poster_rows: Option<u32>,
) -> Result<bool, String> {
    use tauri::Emitter;
    let auto_rotate = auto_rotate.unwrap_or(false);
    let app_done = app.clone();
    let job_id = crate::pdf_engine::print_worker::normalize_print_job_id(&job_id);
    let (cancel_path, progress_path) =
        crate::pdf_engine::print_worker::make_print_control_paths(&job_id);
    print_breadcrumb(&format!(
        "print_pdf_direct: enter job={} isolated printer={:?} pages={:?}-{:?}",
        job_id, printer_name, from_page, to_page
    ));
    let scale_mode_s = scale_mode.clone().unwrap_or_else(|| "shrink".into());
    let job_id_for_worker = job_id.clone();
    let job_id_for_done = job_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let job = crate::pdf_engine::print_worker::PrintWorkerJob::PrintDirect {
            job_id: job_id_for_worker,
            cancel_path,
            progress_path,
            file_path: file_path.clone(),
            printer_name,
            output_path,
            from_page,
            to_page,
            pages,
            copies: normalize_copies(copies),
            collate: collate.unwrap_or(true),
            scale_mode: scale_mode_s,
            scale_percent,
            orientation,
            auto_rotate,
            grayscale: grayscale.unwrap_or(false),
            print_annotations: print_annotations.unwrap_or(true),
            reverse: reverse.unwrap_or(false),
            page_subset,
            layout_mode,
            pages_per_sheet: pages_per_sheet.unwrap_or(2).clamp(1, 16),
            poster_cols: poster_cols.unwrap_or(2).clamp(1, 6),
            poster_rows: poster_rows.unwrap_or(2).clamp(1, 6),
            devmode,
        };
        let r = crate::pdf_engine::print_worker::run_isolated_print(job, app_done.clone())
            .map(|res| res.printed.unwrap_or(false));
        if delete_after.unwrap_or(false) {
            remove_owned_print_temp(&file_path);
        }
        let _ = app_done.emit(
            "print-progress",
            serde_json::json!({
                "jobId": job_id_for_done,
                "current": 0,
                "total": 0,
                "done": true
            }),
        );
        print_breadcrumb(&format!("print_pdf_direct: leave job={}", job_id_for_done));
        r
    })
    .await
    .map_err(|e| format!("Luồng in bị lỗi: {e}"))?;
    result
}

#[cfg(windows)]
#[tauri::command]
pub fn cancel_print_job(job_id: String) -> Result<bool, String> {
    crate::pdf_engine::print_worker::cancel_print_worker(&job_id)
}

#[cfg(windows)]
pub(crate) fn print_direct_blocking(
    file_path: String,
    printer_name: String,
    from_page: Option<i32>,
    to_page: Option<i32>,
    pages: Option<Vec<i32>>,
    copies: i32,
    collate: bool,
    mode: ScaleMode,
    orientation: Option<&str>,
    auto_rotate: bool,
    grayscale: bool,
    print_annotations: bool,
    reverse: bool,
    subset: PageSubset,
    layout: LayoutMode,
    pages_per_sheet: u32,
    poster_cols: u32,
    poster_rows: u32,
    output_path: Option<String>,
    devmode: Option<Vec<u8>>,
    control: Option<PrintJobControl>,
) -> Result<bool, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{CreateDCW, DeleteDC, DEVMODEW};

    if file_path.trim().is_empty() {
        return Err("Đường dẫn PDF trống".into());
    }
    if printer_name.trim().is_empty() {
        return Err("Chưa chọn máy in".into());
    }
    if control.as_ref().is_some_and(PrintJobControl::is_cancelled) {
        return Err("Đã hủy lệnh in".into());
    }

    // Mở doc qua raw FFI (giống print_pdf). Mọi nhánh thoát PHẢI đóng doc.
    let pdfium = crate::ensure_pdfium()?;
    let b = pdfium.bindings();
    let doc = {
        let _guard = crate::lock_mutex(&crate::LOAD_LOCK);
        b.FPDF_LoadDocument(&file_path, None)
    };
    if doc.is_null() {
        return Err(format!("Không mở được PDF: {}", file_path));
    }
    let page_count = b.FPDF_GetPageCount(doc);
    if page_count <= 0 {
        b.FPDF_CloseDocument(doc);
        return Err("PDF không có trang nào".into());
    }

    // Khoảng trang dự phòng; danh sách explicit được validate riêng trước StartDocW.
    let (start_pg, end_pg): (i32, i32) = match (from_page, to_page) {
        (Some(f), Some(t)) => (f.max(1), t.min(page_count)),
        _ => (1, page_count),
    };
    if pages.is_none() && start_pg > end_pg {
        b.FPDF_CloseDocument(doc);
        return Err("Khoảng trang không hợp lệ".into());
    }

    // DEVMODE cho orientation (None = mặc định máy in). Giữ Vec sống tới sau CreateDCW.
    let devmode_buf = build_devmode(&printer_name, orientation, devmode.as_deref());
    let devmode_ptr: Option<*const DEVMODEW> = devmode_buf
        .as_ref()
        .map(|buf| buf.as_ptr() as *const DEVMODEW);

    // Tạo HDC in thẳng vào máy in (KHÔNG PrintDlgW). driver=NULL, device=tên máy in.
    let printer_w = to_wide_nul(&printer_name);
    let hdc = unsafe {
        CreateDCW(
            PCWSTR::null(),
            PCWSTR(printer_w.as_ptr()),
            PCWSTR::null(),
            devmode_ptr,
        )
    };
    if hdc.is_invalid() {
        b.FPDF_CloseDocument(doc);
        return Err(format!("Không tạo được HDC cho máy in: {}", printer_name));
    }

    let doc_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("PDF")
        .to_string();

    let opts = PrintJobOptions {
        start_pg,
        end_pg,
        pages,
        page_count,
        copies,
        collate,
        mode,
        auto_rotate,
        grayscale,
        print_annotations,
        reverse,
        subset,
        layout,
        pages_per_sheet,
        poster_cols,
        poster_rows,
    };
    let result = run_print_job(
        b,
        doc,
        hdc,
        opts,
        &doc_name,
        output_path.as_deref(),
        Some(&printer_name),
        control,
    );
    unsafe {
        let _ = DeleteDC(hdc);
    }
    b.FPDF_CloseDocument(doc);
    result.map(|_| true)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
    #[serde(default)]
    pub driver_name: String,
    #[serde(default)]
    pub port_name: String,
    #[serde(default)]
    pub requires_output_path: bool,
    #[serde(default)]
    pub output_extension: Option<String>,
}

// Liệt kê máy in cho dropdown của hộp thoại in. Máy in mặc định đứng đầu (is_default).
// Rỗng → Ok(vec![]) (JS fallback về PrintDlgW). Xem [[nativePrint]].
#[cfg(windows)]
#[tauri::command]
pub async fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    print_breadcrumb("list_printers: enter isolated");
    // Out-of-process EnumPrinters — provider/driver lạ không kéo sập UI.
    let result = tauri::async_runtime::spawn_blocking(|| {
        let job = crate::pdf_engine::print_worker::PrintWorkerJob::ListPrinters;
        match crate::pdf_engine::print_worker::run_isolated(job) {
            Ok(res) => {
                let printers = res.printers.unwrap_or_default();
                print_breadcrumb(&format!("list_printers: ok count={}", printers.len()));
                Ok(printers)
            }
            Err(e) => {
                // Dialog vẫn mở được với list rỗng + PrintDlg fallback
                print_breadcrumb(&format!("list_printers: isolated fail → empty ({e})"));
                Ok(vec![])
            }
        }
    })
    .await
    .map_err(|e| format!("Luồng liệt kê máy in lỗi: {e}"))?;
    print_breadcrumb("list_printers: leave");
    result
}

#[cfg(windows)]
pub(crate) fn list_printers_blocking() -> Result<Vec<PrinterInfo>, String> {
    use windows::core::PWSTR;
    use windows::Win32::Graphics::Printing::{
        EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_INFO_5W,
    };

    // Tên máy in mặc định (two-call). Lỗi → None (tolerate).
    let default_name: Option<String> = unsafe {
        let mut needed: u32 = 0;
        let _ = GetDefaultPrinterW(None, &mut needed);
        if needed == 0 {
            None
        } else {
            let mut buf = vec![0u16; needed as usize];
            if GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut needed).as_bool() {
                let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                Some(String::from_utf16_lossy(&buf[..len]))
            } else {
                None
            }
        }
    };

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    unsafe {
        // Lần 1: lấy byte count cần cấp.
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;
        let _ = EnumPrintersW(flags, None, 5, None, &mut needed, &mut returned);
        if needed == 0 {
            return Ok(vec![]);
        }
        let mut buf = vec![0u8; needed as usize];
        // Lần 2: điền dữ liệu.
        EnumPrintersW(
            flags,
            None,
            5,
            Some(&mut buf[..]),
            &mut needed,
            &mut returned,
        )
        .map_err(|e| format!("EnumPrinters lỗi: {e}"))?;

        // Con trỏ tên trỏ VÀO đuôi buffer — convert String TRƯỚC khi drop buf.
        let infos =
            std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_5W, returned as usize);
        let mut out: Vec<PrinterInfo> = infos
            .iter()
            .map(|info| {
                let name = pwstr_to_string(info.pPrinterName);
                let port_name = pwstr_to_string(info.pPortName);
                let driver_name = get_printer_driver_name(&name).unwrap_or_default();
                let is_default = default_name
                    .as_deref()
                    .map(|d| d.eq_ignore_ascii_case(&name))
                    .unwrap_or(false);
                let (requires_output_path, output_extension) =
                    classify_file_printer(&name, &driver_name, &port_name);
                PrinterInfo {
                    name,
                    is_default,
                    driver_name,
                    port_name,
                    requires_output_path,
                    output_extension,
                }
            })
            .filter(|p| !p.name.is_empty())
            .collect();

        // Máy in mặc định lên đầu.
        out.sort_by_key(|p| !p.is_default);
        Ok(out)
    }
}

#[cfg(windows)]
fn get_printer_driver_name(printer_name: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, GetPrinterDriverW, OpenPrinterW, DRIVER_INFO_2W,
    };

    let printer_w = to_wide_nul(printer_name);
    let mut handle = Default::default();
    unsafe {
        if OpenPrinterW(PCWSTR(printer_w.as_ptr()), &mut handle, None).is_err() {
            return None;
        }
        let mut needed = 0u32;
        let _ = GetPrinterDriverW(handle, PCWSTR::null(), 2, None, &mut needed);
        if needed == 0 {
            let _ = ClosePrinter(handle);
            return None;
        }
        let mut buffer = vec![0u8; needed as usize];
        let ok =
            GetPrinterDriverW(handle, PCWSTR::null(), 2, Some(&mut buffer), &mut needed).as_bool();
        let _ = ClosePrinter(handle);
        if !ok {
            return None;
        }
        let info = &*(buffer.as_ptr() as *const DRIVER_INFO_2W);
        let name = pwstr_to_string(info.pName);
        (!name.is_empty()).then_some(name)
    }
}

fn classify_file_printer(
    printer_name: &str,
    driver_name: &str,
    port_name: &str,
) -> (bool, Option<String>) {
    let identity = format!("{printer_name} {driver_name}").to_ascii_lowercase();
    let file_port = port_name.split(',').any(|port| {
        matches!(
            port.trim().to_ascii_uppercase().as_str(),
            "PORTPROMPT:" | "FILE:"
        )
    });
    let known_pdf = [
        "microsoft print to pdf",
        "adobe pdf",
        "foxit pdf",
        "pdfcreator",
        "bullzip pdf",
        "dopdf",
    ]
    .iter()
    .any(|needle| identity.contains(needle));
    let known_xps = identity.contains("xps document writer");
    let requires_output = file_port || known_pdf || known_xps;
    let extension = if !requires_output {
        None
    } else if known_xps {
        Some("xps".to_string())
    } else {
        Some("pdf".to_string())
    };
    (requires_output, extension)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PrinterGeometry {
    pub paper_w_mm: f64,
    pub paper_h_mm: f64,
    pub printable_w_mm: f64,
    pub printable_h_mm: f64,
    pub margin_left_mm: f64,
    pub margin_top_mm: f64,
}

// Khổ giấy vật lý + vùng in được + lề (mm) của máy in theo orientation — cho preview
// "trang trên khổ giấy". Dựng DEVMODE (orientation) rồi CreateDCW, đọc GetDeviceCaps.
#[cfg(windows)]
#[tauri::command]
pub async fn get_printer_geometry(
    printer_name: String,
    orientation: Option<String>,
    devmode: Option<Vec<u8>>,
) -> Result<PrinterGeometry, String> {
    print_breadcrumb(&format!(
        "get_printer_geometry: enter isolated printer={:?} orient={:?}",
        printer_name, orientation
    ));
    // Out-of-process CreateDC — driver AV không kéo sập UI.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let job = crate::pdf_engine::print_worker::PrintWorkerJob::Geometry {
            printer_name,
            orientation,
            devmode,
        };
        match crate::pdf_engine::print_worker::run_isolated(job) {
            Ok(res) => res
                .geometry
                .ok_or_else(|| "Worker không trả geometry".to_string()),
            Err(e) => {
                print_breadcrumb(&format!("get_printer_geometry: isolated err {e}"));
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Luồng đọc khổ giấy lỗi: {e}"))?;
    print_breadcrumb("get_printer_geometry: leave");
    result
}

#[cfg(windows)]
pub(crate) fn get_printer_geometry_blocking(
    printer_name: String,
    orientation: Option<&str>,
    devmode: Option<Vec<u8>>,
) -> Result<PrinterGeometry, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateDCW, DeleteDC, GetDeviceCaps, DEVMODEW, HORZRES, LOGPIXELSX, LOGPIXELSY,
        PHYSICALHEIGHT, PHYSICALOFFSETX, PHYSICALOFFSETY, PHYSICALWIDTH, VERTRES,
    };

    if printer_name.trim().is_empty() {
        return Err("Chưa chọn máy in".into());
    }

    let devmode_buf = build_devmode(&printer_name, orientation, devmode.as_deref());
    let devmode_ptr: Option<*const DEVMODEW> = devmode_buf
        .as_ref()
        .map(|buf| buf.as_ptr() as *const DEVMODEW);

    let printer_w = to_wide_nul(&printer_name);
    let hdc = unsafe {
        CreateDCW(
            PCWSTR::null(),
            PCWSTR(printer_w.as_ptr()),
            PCWSTR::null(),
            devmode_ptr,
        )
    };
    if hdc.is_invalid() {
        return Err(format!("Không tạo được HDC cho máy in: {}", printer_name));
    }

    let (dpi_x, dpi_y, phys_w, phys_h, print_w, print_h, off_x, off_y) = unsafe {
        (
            GetDeviceCaps(Some(hdc), LOGPIXELSX) as f64,
            GetDeviceCaps(Some(hdc), LOGPIXELSY) as f64,
            GetDeviceCaps(Some(hdc), PHYSICALWIDTH) as f64,
            GetDeviceCaps(Some(hdc), PHYSICALHEIGHT) as f64,
            GetDeviceCaps(Some(hdc), HORZRES) as f64,
            GetDeviceCaps(Some(hdc), VERTRES) as f64,
            GetDeviceCaps(Some(hdc), PHYSICALOFFSETX) as f64,
            GetDeviceCaps(Some(hdc), PHYSICALOFFSETY) as f64,
        )
    };
    unsafe {
        let _ = DeleteDC(hdc);
    }

    if dpi_x <= 0.0 || dpi_y <= 0.0 {
        return Err("Máy in không cung cấp độ phân giải hợp lệ".into());
    }
    // px → mm. Một số máy in ảo không báo PHYSICAL* → fallback dùng printable area.
    let px_to_mm_x = |px: f64| px / dpi_x * 25.4;
    let px_to_mm_y = |px: f64| px / dpi_y * 25.4;
    let paper_w = if phys_w > 0.0 { phys_w } else { print_w };
    let paper_h = if phys_h > 0.0 { phys_h } else { print_h };

    Ok(PrinterGeometry {
        paper_w_mm: px_to_mm_x(paper_w),
        paper_h_mm: px_to_mm_y(paper_h),
        printable_w_mm: px_to_mm_x(print_w),
        printable_h_mm: px_to_mm_y(print_h),
        margin_left_mm: px_to_mm_x(off_x),
        margin_top_mm: px_to_mm_y(off_y),
    })
}

// Dọn file tạm prynx_print_*.pdf khi user hủy hộp thoại in (JS đã ghi temp cho preview).
// An toàn sẵn: remove_owned_print_temp chỉ xóa prynx_print_*.pdf trong temp dir.
#[cfg(windows)]
#[tauri::command]
pub fn delete_print_temp(path: String) -> Result<(), String> {
    remove_owned_print_temp(&path);
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn print_pdf(
    _window: tauri::WebviewWindow,
    _file_path: String,
    _from_page: Option<i32>,
    _to_page: Option<i32>,
    _pages: Option<Vec<i32>>,
    _delete_after: Option<bool>,
    _scale_mode: Option<String>,
    _auto_rotate: Option<bool>,
) -> Result<bool, String> {
    Err("In native chỉ hỗ trợ trên Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn open_printer_properties(
    _window: tauri::WebviewWindow,
    _printer_name: String,
    _current_devmode: Option<Vec<u8>>,
    _advanced: Option<bool>,
) -> Result<Option<Vec<u8>>, String> {
    Err("In native chỉ hỗ trợ trên Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    Err("In native chỉ hỗ trợ trên Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn get_printer_geometry(
    _printer_name: String,
    _orientation: Option<String>,
    _devmode: Option<Vec<u8>>,
) -> Result<PrinterGeometry, String> {
    Err("In native chỉ hỗ trợ trên Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn delete_print_temp(_path: String) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn print_pdf_direct(
    _app: tauri::AppHandle,
    _job_id: String,
    _file_path: String,
    _printer_name: String,
    _output_path: Option<String>,
    _from_page: Option<i32>,
    _to_page: Option<i32>,
    _pages: Option<Vec<i32>>,
    _copies: Option<i32>,
    _collate: Option<bool>,
    _delete_after: Option<bool>,
    _scale_mode: Option<String>,
    _scale_percent: Option<f64>,
    _orientation: Option<String>,
    _auto_rotate: Option<bool>,
    _grayscale: Option<bool>,
    _print_annotations: Option<bool>,
    _devmode: Option<Vec<u8>>,
    _reverse: Option<bool>,
    _page_subset: Option<String>,
    _layout_mode: Option<String>,
    _pages_per_sheet: Option<u32>,
    _poster_cols: Option<u32>,
    _poster_rows: Option<u32>,
) -> Result<bool, String> {
    Err("In native chỉ hỗ trợ trên Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn cancel_print_job(_job_id: String) -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{
        classify_file_printer, fit_ratio, for_each_print_page, normalize_copies, parse_scale_mode,
        plan_scale, plan_scale_with_rotation_dimensions, resolve_scale_mode, ScaleMode,
    };

    fn collect_pages(start: i32, end: i32, copies: i32, collate: bool) -> Vec<i32> {
        let mut pages = Vec::new();
        for_each_print_page(start, end, copies, collate, |page| {
            pages.push(page);
            Ok::<(), ()>(())
        })
        .unwrap();
        pages
    }

    #[test]
    fn file_printers_are_classified_before_start_doc() {
        assert_eq!(
            classify_file_printer(
                "Microsoft Print to PDF",
                "Microsoft Print To PDF",
                "PORTPROMPT:"
            ),
            (true, Some("pdf".into()))
        );
        assert_eq!(
            classify_file_printer("Microsoft XPS Document Writer", "XPSDrv", "PORTPROMPT:"),
            (true, Some("xps".into()))
        );
        assert_eq!(
            classify_file_printer("Máy in xưởng", "Generic Driver", "USB001"),
            (false, None)
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Tạo một job Microsoft Print to PDF thật; chỉ chạy thủ công khi audit runtime"]
    fn microsoft_print_to_pdf_runtime_smoke() {
        let input =
            std::env::var("PRYNX_PRINT_SMOKE_INPUT").expect("Thiếu PRYNX_PRINT_SMOKE_INPUT");
        let output =
            std::env::var("PRYNX_PRINT_SMOKE_OUTPUT").expect("Thiếu PRYNX_PRINT_SMOKE_OUTPUT");
        let printer = std::env::var("PRYNX_PRINT_SMOKE_PRINTER")
            .unwrap_or_else(|_| "Microsoft Print to PDF".into());

        let printed = super::print_direct_blocking(
            input,
            printer,
            Some(1),
            Some(1),
            None,
            1,
            true,
            ScaleMode::Actual,
            Some("auto"),
            false,
            false,
            true,
            false,
            crate::pdf_engine::print_layout::PageSubset::All,
            crate::pdf_engine::print_layout::LayoutMode::Size,
            2,
            2,
            2,
            Some(output.clone()),
            None,
            None,
        )
        .expect("Job Microsoft Print to PDF phải hoàn tất");
        assert!(printed);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut output_ready = false;
        while std::time::Instant::now() < deadline {
            if std::fs::metadata(&output)
                .map(|meta| meta.len() > 100)
                .unwrap_or(false)
            {
                output_ready = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            output_ready,
            "Job báo xong nhưng không sinh file PDF hợp lệ: {output}"
        );

        let pdfium = crate::ensure_pdfium().expect("Phải mở lại được PDF kết quả");
        let bindings = pdfium.bindings();
        let doc = bindings.FPDF_LoadDocument(&output, None);
        assert!(!doc.is_null(), "PDF kết quả phải mở lại được");
        assert_eq!(bindings.FPDF_GetPageCount(doc), 1);
        let mut width_pt = 0.0;
        let mut height_pt = 0.0;
        assert_ne!(
            bindings.FPDF_GetPageSizeByIndex(doc, 0, &mut width_pt, &mut height_pt),
            0
        );
        bindings.FPDF_CloseDocument(doc);
        assert!(width_pt > 0.0 && height_pt > 0.0);
    }

    #[test]
    fn copies_are_clamped_to_a_safe_range() {
        assert_eq!(normalize_copies(None), 1);
        assert_eq!(normalize_copies(Some(0)), 1);
        assert_eq!(normalize_copies(Some(1_000_000)), 999);
    }

    #[test]
    fn collated_copies_keep_each_document_together() {
        assert_eq!(collect_pages(1, 3, 2, true), vec![1, 2, 3, 1, 2, 3]);
    }

    #[test]
    fn uncollated_copies_group_identical_pages() {
        assert_eq!(collect_pages(1, 3, 2, false), vec![1, 1, 2, 2, 3, 3]);
    }

    #[test]
    fn parse_scale_mode_defaults_to_shrink() {
        assert_eq!(parse_scale_mode(None), ScaleMode::Shrink);
        assert_eq!(parse_scale_mode(Some("bogus")), ScaleMode::Shrink);
        assert_eq!(parse_scale_mode(Some("actual")), ScaleMode::Actual);
        assert_eq!(parse_scale_mode(Some("fit")), ScaleMode::Fit);
    }

    #[test]
    fn fit_ratio_guards_zero_dimension() {
        assert_eq!(fit_ratio(0.0, 100.0, 800.0, 1200.0), 1.0);
        assert_eq!(fit_ratio(100.0, 0.0, 800.0, 1200.0), 1.0);
    }

    #[test]
    fn actual_mode_is_always_full_scale_no_rotate() {
        // Trang nhỏ hơn giấy: Actual giữ 1.0 (không phóng to).
        let (scale, rotated) = plan_scale(400.0, 600.0, 800.0, 1200.0, ScaleMode::Actual, true);
        assert_eq!(scale, 1.0);
        assert!(!rotated);
    }

    #[test]
    fn shrink_mode_keeps_small_page_at_full_scale() {
        // Trang lọt khổ → giữ nguyên 100% (không phóng to như Fit).
        let (scale, _) = plan_scale(400.0, 600.0, 800.0, 1200.0, ScaleMode::Shrink, false);
        assert_eq!(scale, 1.0);
    }

    #[test]
    fn shrink_mode_shrinks_oversized_page() {
        // Trang lớn gấp đôi khổ → thu về 0.5.
        let (scale, _) = plan_scale(1600.0, 2400.0, 800.0, 1200.0, ScaleMode::Shrink, false);
        assert!((scale - 0.5).abs() < 1e-9);
    }

    #[test]
    fn fit_mode_enlarges_small_page() {
        // Fit phóng trang nhỏ để lấp đầy giấy.
        let (scale, _) = plan_scale(400.0, 600.0, 800.0, 1200.0, ScaleMode::Fit, false);
        assert!((scale - 2.0).abs() < 1e-9);
    }

    #[test]
    fn auto_rotate_picks_rotation_that_fits_larger() {
        // Trang ngang trên giấy dọc: auto_rotate=true → xoay để lớn hơn.
        let (_, rotated) = plan_scale(1200.0, 800.0, 800.0, 1200.0, ScaleMode::Fit, true);
        assert!(rotated);
    }

    #[test]
    fn auto_rotate_uses_axis_specific_dpi_dimensions() {
        // Với DPI X/Y khác nhau, kích thước pixel sau xoay không chỉ là hoán đổi W/H.
        // Normal fit = 0.6; rotated fit = 0.9 nên phải chọn xoay và giữ scale 0.9.
        let (scale, rotated) = plan_scale_with_rotation_dimensions(
            10_000.0,
            10_000.0,
            5_000.0,
            20_000.0,
            6_000.0,
            18_000.0,
            ScaleMode::Fit,
            true,
        );
        assert!(rotated);
        assert!((scale - 0.9).abs() < 1e-9);
    }

    #[cfg(windows)]
    #[test]
    fn pdfium_page_size_already_includes_intrinsic_rotation() {
        use pdfium_render::prelude::{PdfPagePaperSize, PdfPageRenderRotation, PdfPoints};

        let pdfium = crate::ensure_pdfium().expect("PDFium must load for rotation test");
        let mut document = pdfium.create_new_pdf().expect("create test PDF");
        {
            let mut page = document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::new_custom(
                    PdfPoints::new(200.0),
                    PdfPoints::new(100.0),
                ))
                .expect("create test page");
            page.set_rotation(PdfPageRenderRotation::Degrees90);
        }

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "prynx_print_rotation_test_{}_{}.pdf",
            std::process::id(),
            unique,
        ));
        document.save_to_file(&path).expect("save rotated PDF");
        drop(document);

        let loaded = pdfium
            .load_pdf_from_file(&path, None)
            .expect("reload rotated PDF");
        let size = loaded.pages().page_size(0).expect("read page size");
        let (width, height) = (size.width().value, size.height().value);
        drop(loaded);
        let _ = std::fs::remove_file(&path);

        assert!((width - 100.0).abs() < 0.01);
        assert!((height - 200.0).abs() < 0.01);
    }

    #[test]
    fn auto_rotate_off_never_rotates() {
        let (_, rotated) = plan_scale(1200.0, 800.0, 800.0, 1200.0, ScaleMode::Fit, false);
        assert!(!rotated);
    }

    #[test]
    fn resolve_scale_mode_maps_all_variants() {
        assert_eq!(resolve_scale_mode(None, None), ScaleMode::Shrink);
        assert_eq!(resolve_scale_mode(Some("bogus"), None), ScaleMode::Shrink);
        assert_eq!(resolve_scale_mode(Some("actual"), None), ScaleMode::Actual);
        assert_eq!(resolve_scale_mode(Some("fit"), None), ScaleMode::Fit);
    }

    #[test]
    fn resolve_scale_mode_custom_percent_to_fraction() {
        // 150% → 1.5; None percent → 1.0 (100%).
        assert_eq!(
            resolve_scale_mode(Some("custom"), Some(150.0)),
            ScaleMode::Custom(1.5)
        );
        assert_eq!(
            resolve_scale_mode(Some("custom"), None),
            ScaleMode::Custom(1.0)
        );
    }

    #[test]
    fn resolve_scale_mode_custom_clamps_extremes() {
        // 0% → 0.01 (1%); 5000% → 10.0 (1000%).
        assert_eq!(
            resolve_scale_mode(Some("custom"), Some(0.0)),
            ScaleMode::Custom(0.01)
        );
        assert_eq!(
            resolve_scale_mode(Some("custom"), Some(5000.0)),
            ScaleMode::Custom(10.0)
        );
    }

    #[test]
    fn custom_mode_uses_exact_fraction() {
        // Custom(1.5) → scale 1.5 bất kể kích thước trang.
        let (scale, _) = plan_scale(400.0, 600.0, 800.0, 1200.0, ScaleMode::Custom(1.5), false);
        assert!((scale - 1.5).abs() < 1e-9);
    }

    #[cfg(windows)]
    #[test]
    fn orientation_to_devmode_maps_correctly() {
        use super::orientation_to_devmode;
        assert_eq!(orientation_to_devmode(Some("portrait")), Some(1));
        assert_eq!(orientation_to_devmode(Some("landscape")), Some(2));
        assert_eq!(orientation_to_devmode(Some("auto")), None);
        assert_eq!(orientation_to_devmode(None), None);
        assert_eq!(orientation_to_devmode(Some("bogus")), None);
    }
}
