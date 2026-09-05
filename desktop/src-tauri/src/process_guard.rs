//! [PROC-LIFECYCLE FIX 2026-08-28 §UP.7] Job Object gom mọi tiến trình con của PrynX.
//!
//! Vì sao cần: mọi cách dọn bằng `taskkill` — kể cả `kill_sidecar()` ở `RunEvent::Exit` và
//! `prepare_for_update()` — chỉ chạy khi app còn kịp thực thi code của mình. Ba đường thoát
//! đã xảy ra thật trên máy khách KHÔNG cho ta cơ hội đó:
//!
//!   1. app crash (Event Log: `pdf-inspector.exe` 0xc0000005/0xc000041d ngày 18/07/2026);
//!   2. app treo rồi bị Windows/user kết thúc (Application Hang 01/08/2026, hai lần);
//!   3. `std::process::exit(0)` bên trong tauri-plugin-updater sau khi bung trình cài.
//!
//! Ở cả ba, `pdf-inspector-backend.exe` và display worker sống sót thành tiến trình ngầm:
//! giữ cổng 8321, giữ file trong thư mục cài (làm NSIS không ghi đè được) và ngốn RAM.
//!
//! Job Object là cơ chế DUY NHẤT trên Windows để chính kernel dọn hộ. Mọi tiến trình con
//! được gán vào một job có cờ `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; handle job chỉ do tiến
//! trình app giữ (không cho kế thừa) nên khi app chết vì BẤT KỲ lý do gì, handle đóng và
//! kernel kill sạch cả job. Con của tiến trình trong job cũng tự vào job — nên cây worker
//! Python (`ProcessPoolExecutor`, `multiprocessing`) và `soffice.exe` do sidecar spawn cũng
//! được dọn theo, dù chúng không được gán tay.
//!
//! Từ đây `taskkill` chỉ còn là lưới phụ cho đường thoát êm, không phải cơ chế chính.
//!
//! SEC (audit 2026-09-04 §SEC.22): lỗi tạo/gán Job phải trả về caller. Sidecar và
//! worker giữ file phát hành sẽ tự hủy rồi fail-closed thay vì chạy ngoài Job mà host
//! vẫn tưởng cây tiến trình đã được kernel bảo vệ.

/// Gán một tiến trình con vào job của app để OS tự diệt khi app chết.
/// Gọi càng sớm sau `spawn()` càng tốt: tiến trình cháu sinh ra TRƯỚC lúc gán sẽ không
/// thuộc job (đây là lý do lời gọi nằm ngay sau `spawn`, trước mọi handshake).
pub fn adopt_child_process(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let result = windows_impl::try_adopt_child_process(pid);
        match &result {
            Ok(()) => log::info!("[JOB] Đã gán PID={pid} vào job của PrynX."),
            Err(error) => log::error!("[JOB] Không gán được PID={pid} vào job: {error}"),
        }
        result
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Ok(())
    }
}

/// SEC (audit 2026-09-04 §SEC.22): chỉ chạy `taskkill.exe` chuẩn trong System32.
/// Không phân giải qua PATH/SystemRoot do process hoặc user có thể kiểm soát.
#[cfg(windows)]
pub(crate) fn system_taskkill_path() -> Result<std::path::PathBuf, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;

    // Win32 extended-length path tối đa 32.767 UTF-16 code units.
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: buffer writable và sống hết lời gọi; wrapper nhận đúng chiều dài slice.
    let written = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if written == 0 || written >= buffer.len() {
        return Err("Không xác định được Windows system directory".to_string());
    }

    let directory = std::path::PathBuf::from(OsString::from_wide(&buffer[..written]));
    let is_system32 = directory
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("System32"));
    if !directory.is_absolute() || !is_system32 {
        return Err("Windows system directory không hợp lệ".to_string());
    }

    let taskkill = directory.join("taskkill.exe");
    let metadata = std::fs::metadata(&taskkill)
        .map_err(|error| format!("Không tìm thấy taskkill.exe hệ thống: {error}"))?;
    if !metadata.is_file() {
        return Err("taskkill.exe hệ thống không phải file".to_string());
    }
    Ok(taskkill)
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// Lưu giá trị con trỏ handle thay vì `HANDLE` để không phải `unsafe impl Send/Sync`
    /// cho một static. `None` = không dựng được job; caller sẽ fail-closed.
    static JOB_HANDLE: OnceLock<Option<usize>> = OnceLock::new();

    fn job_handle() -> Option<HANDLE> {
        (*JOB_HANDLE.get_or_init(create_job)).map(|raw| HANDLE(raw as *mut core::ffi::c_void))
    }

    fn create_job() -> Option<usize> {
        unsafe {
            // Job vô danh: handle không kế thừa được nên tiến trình con KHÔNG giữ thêm
            // handle nào. Nếu con giữ handle thì job không đóng khi app chết và cả cơ chế
            // này mất tác dụng.
            let job = match CreateJobObjectW(None, PCWSTR::null()) {
                Ok(handle) => handle,
                Err(error) => {
                    log::warn!("[JOB] Không tạo được Job Object: {error}; dựa vào taskkill.");
                    return None;
                }
            };

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                log::warn!("[JOB] Không đặt được cờ KILL_ON_JOB_CLOSE: {error}; bỏ job.");
                // Job không có cờ này còn tệ hơn không có job: tiến trình bị gom vào một
                // job vô dụng mà ta lại tin là đã được bảo vệ.
                let _ = CloseHandle(job);
                return None;
            }

            log::info!("[JOB] Job Object đã sẵn sàng (KILL_ON_JOB_CLOSE).");
            Some(job.0 as usize)
        }
    }

    pub fn try_adopt_child_process(pid: u32) -> Result<(), String> {
        if pid == 0 {
            return Err("PID không hợp lệ".to_string());
        }
        let job = job_handle().ok_or_else(|| "job chưa dựng được".to_string())?;
        unsafe {
            // PROCESS_SET_QUOTA + PROCESS_TERMINATE là đúng bộ quyền tối thiểu
            // AssignProcessToJobObject đòi; không xin thêm để không nới quyền vô cớ.
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|error| format!("không mở được tiến trình: {error}"))?;
            let assigned = AssignProcessToJobObject(job, process)
                .map_err(|error| format!("AssignProcessToJobObject: {error}"));
            let _ = CloseHandle(process);
            assigned
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::core::BOOL;
        use windows::Win32::System::JobObjects::{IsProcessInJob, QueryInformationJobObject};
        use windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;

        /// Đọc tư cách thành viên job của một PID.
        /// `IsProcessInJob` đòi quyền QUERY_LIMITED_INFORMATION — KHÔNG dùng lại bộ quyền
        /// SET_QUOTA|TERMINATE của đường gán, nếu không hàm trả ACCESS_DENIED và ta dễ đọc
        /// nhầm thành "không nằm trong job".
        fn doc_tu_cach_job(pid: u32) -> Result<bool, String> {
            unsafe {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    .map_err(|error| format!("OpenProcess(query): {error}"))?;
                let mut in_job = BOOL(0);
                let query = IsProcessInJob(process, job_handle(), &mut in_job)
                    .map_err(|error| format!("IsProcessInJob: {error}"));
                let _ = CloseHandle(process);
                query.map(|()| in_job.as_bool())
            }
        }

        /// Kiểm chính cờ kernel mà lifecycle dựa vào; membership đơn thuần không
        /// chứng minh Job sẽ diệt cây khi handle của host đóng.
        fn doc_cau_hinh_job() -> Result<JOBOBJECT_EXTENDED_LIMIT_INFORMATION, String> {
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    job_handle(),
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    None,
                )
            }
            .map_err(|error| format!("QueryInformationJobObject: {error}"))?;
            Ok(info)
        }

        /// Kiểm đúng điều dễ hỏng nhất khi nâng crate `windows` hoặc đổi feature: job dựng
        /// được và tiến trình con THẬT SỰ vào job. Không kiểm được KILL_ON_JOB_CLOSE ở đây
        /// (phải để tiến trình cha chết mới thấy) — phần đó là kiểm tay runtime.
        #[test]
        fn tien_trinh_con_duoc_gan_vao_job() {
            let mut child = std::process::Command::new("cmd")
                .args(["/c", "ping -n 20 127.0.0.1 > NUL"])
                .spawn()
                .expect("spawn tiến trình phụ để kiểm job");
            let pid = child.id();

            let assigned = try_adopt_child_process(pid);
            let membership = doc_tu_cach_job(pid);

            let _ = child.kill();
            let _ = child.wait();

            assert!(assigned.is_ok(), "gán job thất bại: {assigned:?}");
            assert_eq!(
                membership,
                Ok(true),
                "tiến trình con không nằm trong job của PrynX"
            );
        }

        #[test]
        fn job_bat_kill_on_close() {
            let info = doc_cau_hinh_job().expect("đọc cấu hình Job Object");
            assert!(
                info.BasicLimitInformation
                    .LimitFlags
                    .contains(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
                "Job Object thiếu KILL_ON_JOB_CLOSE"
            );
        }

        #[test]
        fn taskkill_chi_duoc_goi_bang_duong_system32_tuyet_doi() {
            let taskkill = crate::process_guard::system_taskkill_path()
                .expect("phải tìm được taskkill.exe hệ thống");
            assert!(taskkill.is_absolute());
            assert_eq!(
                taskkill.file_name().and_then(|value| value.to_str()),
                Some("taskkill.exe")
            );
            assert_eq!(
                taskkill
                    .parent()
                    .and_then(|path| path.file_name())
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("system32")
            );

            let raw_path_lookup = ["Command::new(\"", "taskkill", "\")"].concat();
            for source in [
                include_str!("lib.rs"),
                include_str!("pdf_engine/render_worker.rs"),
                include_str!("pdf_engine/print_worker.rs"),
            ] {
                let compact = source
                    .chars()
                    .filter(|character| !character.is_whitespace())
                    .collect::<String>();
                assert!(
                    !compact.contains(&raw_path_lookup),
                    "Không được phân giải taskkill qua PATH"
                );
            }
        }
    }
}
