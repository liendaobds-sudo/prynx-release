//! UIUX (audit 2026-09-25 §R25.GPU.30): popup HTML nhận cả pixel và input trong vùng riêng.
use super::interaction::Rect;
use windows::Win32::{Foundation::HWND, Graphics::Gdi::*};

/// Tọa độ exclusion là pixel vật lý, tương đối với client của child.
/// SetWindowRgn nhận ownership khi thành công; không giữ khóa state qua Win32.
pub fn set_exclusions(hwnd: HWND, width: u32, height: u32, holes: &[Rect]) -> Result<(), String> {
    if width > i32::MAX as u32 || height > i32::MAX as u32 || holes.iter().any(|r| !r.valid()) {
        return Err("Vùng popup không hợp lệ".into());
    }
    unsafe {
        if holes.is_empty() {
            return if SetWindowRgn(hwnd, None, true) != 0 {
                Ok(())
            } else {
                Err("Không khôi phục được vùng PDF".into())
            };
        }
        let region = CreateRectRgn(0, 0, width as i32, height as i32);
        if region.0.is_null() {
            return Err("Không tạo được vùng PDF".into());
        }
        for r in holes {
            let clip = CreateRectRgn(
                r.x.floor().max(0.).min(width as f32) as i32,
                r.y.floor().max(0.).min(height as f32) as i32,
                (r.x + r.width).ceil().max(0.).min(width as f32) as i32,
                (r.y + r.height).ceil().max(0.).min(height as f32) as i32,
            );
            if clip.0.is_null() {
                let _ = DeleteObject(region.into());
                return Err("Không tạo được vùng popup".into());
            }
            let result = CombineRgn(Some(region), Some(region), Some(clip), RGN_DIFF);
            let _ = DeleteObject(clip.into());
            if result == RGN_ERROR {
                let _ = DeleteObject(region.into());
                return Err("Không loại trừ được popup".into());
            }
        }
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(region.into());
            return Err("Không cập nhật được vùng popup".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
    #[test]
    fn native_region_exposes_popup_and_restores_after_close() {
        unsafe {
            let hwnd = CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("test ẩn"),
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
            .unwrap();
            set_exclusions(
                hwnd,
                300,
                200,
                &[Rect {
                    x: 20.5,
                    y: 30.5,
                    width: 49.,
                    height: 29.,
                }],
            )
            .unwrap();
            let r = CreateRectRgn(0, 0, 0, 0);
            GetWindowRgn(hwnd, r);
            assert!(PtInRegion(r, 10, 10).as_bool());
            assert!(!PtInRegion(r, 21, 31).as_bool());
            assert!(PtInRegion(r, 71, 61).as_bool());
            let _ = DeleteObject(r.into());
            set_exclusions(hwnd, 300, 200, &[]).unwrap();
            let r = CreateRectRgn(0, 0, 0, 0);
            assert_eq!(GetWindowRgn(hwnd, r), RGN_ERROR);
            let _ = DeleteObject(r.into());
            DestroyWindow(hwnd).unwrap();
        }
    }
    #[test]
    fn excluded_pixels_send_hit_test_to_webview_sibling() {
        use windows::Win32::Foundation::POINT;
        unsafe {
            let parent = CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("Parent ẩn"),
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
            .unwrap();
            let webview = CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("WebView test"),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                200,
                100,
                Some(parent),
                None,
                None,
                None,
            )
            .unwrap();
            let viewport = CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("Viewport test"),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                200,
                100,
                Some(parent),
                None,
                None,
                None,
            )
            .unwrap();
            SetWindowPos(
                viewport,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            .unwrap();
            set_exclusions(
                viewport,
                200,
                100,
                &[Rect {
                    x: 20.,
                    y: 20.,
                    width: 30.,
                    height: 30.,
                }],
            )
            .unwrap();
            // RealChildWindowFromPoint có xét region; không đọc/điều khiển cửa sổ khác.
            assert_eq!(
                RealChildWindowFromPoint(parent, POINT { x: 30, y: 30 }),
                webview
            );
            assert_eq!(
                RealChildWindowFromPoint(parent, POINT { x: 10, y: 10 }),
                viewport
            );
            DestroyWindow(parent).unwrap();
        }
    }
}
