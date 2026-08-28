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
//! Không fail-closed: mọi lỗi API chỉ ghi log rồi bỏ qua. Job Object có thể không gán được
//! trong môi trường đặc biệt (đã nằm trong job không cho lồng, quyền bị hạn chế) và điều đó
//! KHÔNG được phép chặn app khởi động — hành vi khi ấy đúng bằng hành vi cũ.

/// Gán một tiến trình con vào job của app để OS tự diệt khi app chết.
/// Gọi càng sớm sau `spawn()` càng tốt: tiến trình cháu sinh ra TRƯỚC lúc gán sẽ không
/// thuộc job (đây là lý do lời gọi nằm ngay sau `spawn`, trước mọi handshake).
pub fn adopt_child_process(pid: u32) {
    #[cfg(windows)]
    match windows_impl::try_adopt_child_process(pid) {
        Ok(()) => log::info!("[JOB] Đã gán PID={pid} vào job của PrynX."),
        Err(error) => log::warn!("[JOB] Không gán được PID={pid} vào job: {error}; dựa vào taskkill."),
    }
    #[cfg(not(windows))]
    let _ = pid;
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// Lưu giá trị con trỏ handle thay vì `HANDLE` để không phải `unsafe impl Send/Sync`
    /// cho một static. `None` = không dựng được job, mọi lời gọi sau đó thành no-op.
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
        use windows::Win32::System::JobObjects::IsProcessInJob;
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
    }
}
