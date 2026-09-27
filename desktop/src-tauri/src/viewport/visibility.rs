//! PERF (audit 2026-09-25 §R25.GPU.26): child mới nằm dưới WebView đã tạo trước.
//! Hiện viewport phải chốt cả z-order; ShowWindow đơn thuần chỉ đổi WS_VISIBLE.
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, SWP_SHOWWINDOW,
    },
};

/// Caller chạy trên UI thread, không giữ khóa state vì Win32 gọi lại WndProc.
pub(super) fn set_child_visibility(hwnd: HWND, visible: bool) -> Result<(), String> {
    let flags = SWP_NOMOVE
        | SWP_NOSIZE
        | SWP_NOACTIVATE
        | if visible {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW | SWP_NOZORDER
        };
    unsafe {
        // HWND_TOP chỉ đổi thứ tự giữa các sibling, không biến app thành topmost.
        SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, flags)
            .map_err(|e| format!("Không cập nhật được vùng hiển thị PDF: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        core::w,
        Win32::{Foundation::RECT, UI::WindowsAndMessaging::*},
    };

    struct Host(HWND);
    impl Host {
        fn new() -> Self {
            // Parent ẩn: không chiếm focus hoặc tác động cửa sổ người dùng.
            Self(unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("STATIC"),
                    w!("test"),
                    WS_OVERLAPPED,
                    0,
                    0,
                    300,
                    200,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap()
            })
        }
        fn child(&self, visible: bool) -> HWND {
            unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("STATIC"),
                    w!("sibling"),
                    WS_CHILD
                        | WS_CLIPSIBLINGS
                        | if visible {
                            WS_VISIBLE
                        } else {
                            Default::default()
                        },
                    20,
                    20,
                    200,
                    100,
                    Some(self.0),
                    None,
                    None,
                    None,
                )
                .unwrap()
            }
        }
        fn top(&self) -> HWND {
            unsafe { GetTopWindow(Some(self.0)).unwrap() }
        }
    }
    impl Drop for Host {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    fn shown(hwnd: HWND) -> bool {
        unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & WS_VISIBLE.0 != 0 }
    }

    #[test]
    fn viewport_rises_above_existing_webview_without_moving_or_activating() {
        let host = Host::new();
        let webview = host.child(true);
        let viewport = host.child(false);
        assert_eq!(host.top(), webview);
        let mut before = RECT::default();
        let mut after = RECT::default();
        unsafe {
            GetWindowRect(viewport, &mut before).unwrap();
        }
        let foreground = unsafe { GetForegroundWindow() };
        set_child_visibility(viewport, true).unwrap();
        assert_eq!(host.top(), viewport);
        assert!(shown(viewport));
        unsafe {
            GetWindowRect(viewport, &mut after).unwrap();
        }
        assert_eq!(before, after);
        assert_eq!(unsafe { GetForegroundWindow() }, foreground);
    }

    #[test]
    fn hiding_for_dialog_does_not_raise_viewport_and_show_restores_it() {
        let host = Host::new();
        let _webview = host.child(true);
        let viewport = host.child(false);
        set_child_visibility(viewport, true).unwrap();
        let dialog = host.child(false);
        set_child_visibility(dialog, true).unwrap();
        assert_eq!(host.top(), dialog);
        set_child_visibility(viewport, false).unwrap();
        assert!(!shown(viewport));
        assert_eq!(host.top(), dialog);
        set_child_visibility(dialog, false).unwrap();
        set_child_visibility(viewport, true).unwrap();
        assert!(shown(viewport));
        assert_eq!(host.top(), viewport);
    }

    #[test]
    fn switching_viewports_keeps_inactive_child_hidden() {
        let host = Host::new();
        let _webview = host.child(true);
        let first = host.child(false);
        let second = host.child(false);
        set_child_visibility(first, true).unwrap();
        set_child_visibility(first, false).unwrap();
        set_child_visibility(second, true).unwrap();
        assert!(!shown(first));
        assert!(shown(second));
        assert_eq!(host.top(), second);
        set_child_visibility(first, false).unwrap();
        assert!(shown(second));
        assert_eq!(host.top(), second);
    }

    #[test]
    fn destroyed_viewport_returns_error_instead_of_false_success() {
        let host = Host::new();
        let viewport = host.child(false);
        unsafe {
            DestroyWindow(viewport).unwrap();
        }
        assert!(set_child_visibility(viewport, true).is_err());
        assert!(set_child_visibility(viewport, false).is_err());
    }
}
