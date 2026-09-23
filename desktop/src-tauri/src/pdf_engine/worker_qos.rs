//! Chính sách QoS chỉ dành cho process render worker, không đổi thiết lập Windows.

#[cfg(any(windows, test))]
fn use_high_qos(raw: Option<&str>) -> bool {
    !raw.is_some_and(|value| value.trim().eq_ignore_ascii_case("system"))
}

#[cfg(windows)]
fn high_qos_state(
    mut state: windows::Win32::System::Threading::PROCESS_POWER_THROTTLING_STATE,
) -> windows::Win32::System::Threading::PROCESS_POWER_THROTTLING_STATE {
    use windows::Win32::System::Threading::{
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    };
    state.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    // Giữ các cơ chế đã được caller điều khiển (ví dụ timer resolution), không
    // biến trạng thái do OS tự suy ra thành một thiết lập mới của ứng dụng.
    state.StateMask &= state.ControlMask;
    state.ControlMask |= PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    state.StateMask &= !PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    state
}

#[cfg(windows)]
fn apply_high_qos() -> windows::core::Result<()> {
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetProcessInformation, ProcessPowerThrottling, SetProcessInformation,
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_STATE,
    };
    let mut state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ..Default::default()
    };
    let size = std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32;
    // Handle chỉ trỏ process worker hiện tại; buffer POD đúng kích thước và
    // sống hết lời gọi. Không gọi API đổi affinity, priority class hay registry.
    unsafe {
        let process = GetCurrentProcess();
        GetProcessInformation(
            process,
            ProcessPowerThrottling,
            std::ptr::from_mut(&mut state).cast(),
            size,
        )?;
        state = high_qos_state(state);
        SetProcessInformation(
            process,
            ProcessPowerThrottling,
            std::ptr::from_ref(&state).cast(),
            size,
        )
    }
}

pub(super) fn configure() {
    #[cfg(windows)]
    {
        // PERF (audit 2026-09-23 §R23.WORKER-QOS): worker không có cửa sổ nhưng
        // đang phục vụ Viewer. Để OS suy QoS từ visibility có thể đẩy replay/encode
        // sang nhóm CPU tiết kiệm điện. HighQoS không ghim core hay giảm số worker.
        // PRYNX_RENDER_WORKER_QOS=system giữ hành vi cũ cho A/B và rollback.
        let policy = std::env::var("PRYNX_RENDER_WORKER_QOS").ok();
        if !use_high_qos(policy.as_deref()) {
            crate::perf_log(&format!(
                "PPE_WORKER_QOS pid={} policy=system",
                std::process::id()
            ));
            return;
        }
        match apply_high_qos() {
            Ok(()) => crate::perf_log(&format!(
                "PPE_WORKER_QOS pid={} policy=high applied=1",
                std::process::id()
            )),
            Err(error) => {
                // QoS chỉ là gợi ý hiệu năng: OS cũ/từ chối API vẫn phải render
                // đúng, không đổi engine hoặc hạ chất lượng để vượt lỗi này.
                eprintln!("[PXRW] Không đặt được HighQoS cho render worker: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_dinh_high_va_co_duong_ab_ve_system() {
        assert!(use_high_qos(None));
        assert!(use_high_qos(Some("high")));
        assert!(use_high_qos(Some("khong-hop-le")));
        assert!(!use_high_qos(Some(" SYSTEM ")));
    }

    #[cfg(windows)]
    #[test]
    fn chi_tat_execution_throttle_giu_co_timer_da_duoc_dieu_khien() {
        use windows::Win32::System::Threading::{
            PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED as SPEED,
            PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION as TIMER,
            PROCESS_POWER_THROTTLING_STATE,
        };
        for control in [0, SPEED, TIMER, SPEED | TIMER] {
            for state in [0, SPEED, TIMER, SPEED | TIMER] {
                let result = high_qos_state(PROCESS_POWER_THROTTLING_STATE {
                    Version: 0,
                    ControlMask: control,
                    StateMask: state,
                });
                assert_eq!(result.Version, PROCESS_POWER_THROTTLING_CURRENT_VERSION);
                assert_eq!(result.ControlMask, control | SPEED);
                assert_eq!(result.StateMask & SPEED, 0);
                assert_eq!(result.StateMask & TIMER, state & control & TIMER);
            }
        }
    }
}
