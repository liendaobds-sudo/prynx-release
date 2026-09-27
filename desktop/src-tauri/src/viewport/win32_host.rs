//! PPE Viewer GPU - Win32 Child HWND & wgpu Surface Hosting (Milestone G3.1)
//!
//! Nhung Child HWND truc tiep vao cua so Tauri/WebView2 Host,
//! bat truc tiep su kien chuot (WM_MOUSEWHEEL, WM_LBUTTONDOWN, WM_MOUSEMOVE),
//! thuc thi Anchor Zoom va render swapchain surface ma khong qua React DOM.

use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawDisplayHandle,
    RawWindowHandle, Win32WindowHandle, WindowHandle, WindowsDisplayHandle,
};
use std::num::NonZeroIsize;
use std::sync::{Arc, Mutex};
use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{BeginPaint, EndPaint, InvalidateRect, PAINTSTRUCT};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyState, ReleaseCapture, SetCapture, SetFocus, VK_CONTROL, VK_ESCAPE,
    VK_SPACE, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetCursorPos, GetWindowLongPtrW, LoadCursorW,
    RegisterClassW, SetCursor, SetWindowLongPtrW, SetWindowPos, CS_DBLCLKS, GWLP_USERDATA,
    IDC_ARROW, IDC_HAND, IDC_IBEAM, SWP_NOZORDER, WM_CANCELMODE, WM_CAPTURECHANGED, WM_DESTROY,
    WM_DPICHANGED, WM_ERASEBKGND, WM_KEYDOWN, WM_KEYUP, WM_KILLFOCUS, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_PAINT, WM_RBUTTONUP, WM_SETCURSOR, WM_SIZE, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN,
    WS_CLIPSIBLINGS, SystemParametersInfoW, SPI_GETWHEELSCROLLLINES, SPI_GETWHEELSCROLLCHARS,
};

use super::controller::ViewportController;
use super::interaction::{Interaction, InteractionEvent, Tool};
use super::scheduler::ViewportScheduler;
use print_engine::scene::invalidation::InvalidationLevel;
use viewer_gpu::GpuContext;
#[path = "keyboard_commands.rs"]
mod keyboard_commands;

// UIUX (audit 2026-09-25 §R25.GPU.32): chỉ cập nhật camera trên UI thread;
// WM_PAINT vẫn gom và gửi frame sang presenter, không render từng delta.
fn scroll_native_page(state: &ViewportHostState, delta: i16, horizontal: bool, hardware_horizontal: bool) -> bool {
    let Some(renderer)=state.current_renderer() else { return false; };
    let mut units=3u32;
    unsafe {
        let action=if horizontal { SPI_GETWHEELSCROLLCHARS } else { SPI_GETWHEELSCROLLLINES };
        let _=SystemParametersInfoW(action,0,Some((&mut units as *mut u32).cast()),Default::default());
    }
    if units==0 { return false; }
    let (event,dirty)={
        let Ok(mut sched)=state.scheduler.lock() else { return false; };
        let Ok(mut ctrl)=state.controller.lock() else { return false; };
        // Tiêu thụ delta camera trước đó để xét biên chính xác, giữ mức invalidation.
        if let Some(level)=sched.consume_pending(&mut ctrl) { sched.request_invalidation(level); }
        let viewport_height=ctrl.physical_height as f32/ctrl.dpr;
        let viewport_axis=if horizontal {ctrl.physical_width as f32/ctrl.dpr} else {viewport_height};
        let distance=if units==u32::MAX { viewport_axis } else { (units as f32*32.0).max(96.0) };
        let pan=delta as f32/120.*distance*if hardware_horizontal {-1.} else {1.};
        let scene=&renderer.scene;
        let mut w=scene.bounds.width()*scene.user_unit;
        let mut h=scene.bounds.height()*scene.user_unit;
        if scene.rotation.rem_euclid(180)==90 { std::mem::swap(&mut w,&mut h); }
        let before=ctrl.frame_counter;
        let (at_top,at_bottom)=ctrl.scroll_page(if horizontal {pan} else {0.},if horizontal {0.} else {pan},w,h);
        if ctrl.frame_counter!=before { sched.request_invalidation(InvalidationLevel::L0Camera); }
        // Một nấc tương ứng 100 đơn vị ý định điều hướng như wheel DOM hiện hữu;
        // không phụ thuộc số dòng Windows, không làm tròn delta trackpad.
        (InteractionEvent::Wheel {delta_y:-(delta as f32)/120.*100.,at_top,at_bottom,viewport_height},sched.is_dirty())
    };
    if !horizontal { emit_interaction(state,event); }
    dirty
}

/// Wrapper cho raw-window-handle 0.6 de wgpu gan ket Surface vao HWND Win32
pub struct HwndSurfaceWrapper {
    pub hwnd: HWND,
    pub hinstance: HINSTANCE,
}

unsafe impl Send for HwndSurfaceWrapper {}
unsafe impl Sync for HwndSurfaceWrapper {}

impl HasWindowHandle for HwndSurfaceWrapper {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let mut handle = Win32WindowHandle::new(
            NonZeroIsize::new(self.hwnd.0 as isize).expect("HWND khong the la null"),
        );
        let hinstance_isize = self.hinstance.0 as isize;
        if let Some(hinst_nonzero) = NonZeroIsize::new(hinstance_isize) {
            handle.hinstance = Some(hinst_nonzero);
        }
        let raw = RawWindowHandle::Win32(handle);
        unsafe { Ok(WindowHandle::borrow_raw(raw)) }
    }
}

impl HasDisplayHandle for HwndSurfaceWrapper {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        let handle = WindowsDisplayHandle::new();
        let raw = RawDisplayHandle::Windows(handle);
        unsafe { Ok(DisplayHandle::borrow_raw(raw)) }
    }
}

#[cfg(test)]
mod input_tests {
    use super::super::interaction::{Glyph, Rect, TextLine};
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WS_OVERLAPPED};
    fn point(x: i16, y: i16) -> LPARAM {
        LPARAM((((y as u16 as u32) << 16) | (x as u16 as u32)) as isize)
    }
    #[test]
    fn wheel_routes_fit_page_and_clamps_rotated_user_unit_scene() {
        use print_engine::{scene::retained::RetainedPage, geom::Rect as PageRect};
        use viewer_gpu::retained_renderer::RetainedRenderer;
        unsafe {
            let parent=CreateWindowExW(Default::default(),w!("STATIC"),w!("Test cuộn ẩn"),WS_OVERLAPPED,0,0,400,300,None,None,None,None).unwrap();
            let ctx=Arc::new(GpuContext::new_sync().unwrap());
            let view=Win32ChildViewport::create(parent,0,0,400,300,2.,ctx.clone()).unwrap();
            let scene=Arc::new(RetainedPage {commands:vec![],space:Default::default(),
                bounds:PageRect::new(10.,20.,110.,70.),rotation:90,user_unit:2.,warnings:Default::default()});
            let cm=super::super::scene_worker::color_manager().unwrap();
            let format=view.state.lock().unwrap().surface_config.format;
            let renderer=RetainedRenderer::new(&ctx,scene,&cm,format).unwrap();
            let events=Arc::new(Mutex::new(Vec::new())); let received=events.clone();
            {
                let mut s=view.state.lock().unwrap();
                s.renderer=Some(Arc::new(super::super::document_renderer::DocumentRenderer::gpu(Arc::new(renderer))));
                s.renderer_revision=s.scene_revision.load(std::sync::atomic::Ordering::Acquire);
                s.interaction_event=Some(Arc::new(move |_,e|received.lock().unwrap().push(e)));
                let mut c=s.controller.lock().unwrap(); c.zoom=0.5; c.pan_x=75.; c.pan_y=25.;
            }
            let wheel=|message,delta:i16,flags:usize| {
                SendMessageW(view.hwnd,message,Some(WPARAM(((delta as u16 as usize)<<16)|flags)),Some(point(100,100)));
            };
            // Không đổi thiết lập máy người dùng trong test.
            let mut lines=3u32;
            SystemParametersInfoW(SPI_GETWHEELSCROLLLINES,0,Some((&mut lines as *mut u32).cast()),Default::default()).unwrap();
            wheel(WM_MOUSEWHEEL,-1,0);
            if lines!=0 {
                let e=serde_json::to_value(events.lock().unwrap().last().unwrap()).unwrap();
                assert_eq!(e["kind"],"wheel"); assert_eq!(e["at_top"],true); assert_eq!(e["at_bottom"],true);
                assert!((e["delta_y"].as_f64().unwrap()-100./120.).abs()<0.0001);
            }
            {
                let s=view.state.lock().unwrap(); let c=s.controller.lock().unwrap();
                assert_eq!((c.pan_x,c.pan_y),(75.,25.));
            }
            events.lock().unwrap().clear();
            {
                let s=view.state.lock().unwrap(); let mut c=s.controller.lock().unwrap();
                c.zoom=2.; c.pan_x=0.; c.pan_y=16.;
            }
            wheel(WM_MOUSEWHEEL,-30,0);
            if lines!=0 {
                let distance = if lines == u32::MAX { 150. } else { (lines as f32 * 32.0).max(96.0) };
                let expected = 16. - distance / 4.;
                let y = view.state.lock().unwrap().controller.lock().unwrap().pan_y;
                assert!((y - expected.max(-266.)).abs() < 0.0001);
                let e=serde_json::to_value(events.lock().unwrap().last().unwrap()).unwrap();
                assert_eq!(e["at_top"],true); assert_eq!(e["at_bottom"],false);
                wheel(WM_MOUSEWHEEL,i16::MIN,0); wheel(WM_MOUSEWHEEL,-120,0);
                let y=view.state.lock().unwrap().controller.lock().unwrap().pan_y;
                assert_eq!(y,-266.); // Rotate + UserUnit + DPR: trang cao 400 DIP.
                let e=serde_json::to_value(events.lock().unwrap().last().unwrap()).unwrap();
                assert_eq!(e["at_bottom"],true);
            }
            events.lock().unwrap().clear();
            wheel(WM_MOUSEWHEEL,1,8); wheel(WM_MOUSEWHEEL,30,4); wheel(WM_MOUSEHWHEEL,30,0);
            assert!(events.lock().unwrap().is_empty(),"zoom/shift/hwheel không được lật trang");
            view.destroy().unwrap(); DestroyWindow(parent).unwrap();
        }
    }

    #[test]
    fn fractional_wheel_zoom_keeps_its_magnitude() {
        unsafe {
            let parent=CreateWindowExW(Default::default(),w!("STATIC"),w!("Test wheel ẩn"),WS_OVERLAPPED,0,0,400,300,None,None,None,None).unwrap();
            let ctx=Arc::new(GpuContext::new_sync().unwrap());
            let view=Win32ChildViewport::create(parent,0,0,400,300,2.,ctx).unwrap();
            SendMessageW(view.hwnd,WM_MOUSEWHEEL,Some(WPARAM((1<<16)|8)),Some(point(100,100)));
            SendMessageW(view.hwnd,WM_PAINT,None,None);
            let zoom=view.state.lock().unwrap().controller.lock().unwrap().zoom;
            view.destroy().unwrap(); DestroyWindow(parent).unwrap();
            assert!((zoom-1.15_f32.powf(1./120.)).abs()<0.00001,"delta=1 gave zoom={zoom}");
        }
    }

    #[test]
    fn pointer_selects_text_hand_pans_and_context_menu_keeps_native_camera() {
        unsafe {
            let parent = CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("Test input ẩn"),
                WS_OVERLAPPED,
                0,
                0,
                400,
                300,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let ctx = Arc::new(GpuContext::new_sync().unwrap());
            let view = Win32ChildViewport::create(parent, 0, 0, 400, 300, 2., ctx).unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let received = events.clone();
            {
                let mut s = view.state.lock().unwrap();
                s.interaction_event = Some(Arc::new(move |_, e| received.lock().unwrap().push(e)));
                s.interaction.lines = vec![TextLine {
                    pdf_coordinates: false,
                    link: None,
                    glyphs: "Việt"
                        .chars()
                        .enumerate()
                        .map(|(i, c)| Glyph {
                            text: c.to_string(),
                            bounds: Rect {
                                x: i as f32 * 10.,
                                y: 0.,
                                width: 10.,
                                height: 10.,
                            },
                        })
                        .collect(),
                }];
            }
            SendMessageW(
                view.hwnd,
                WM_LBUTTONDOWN,
                Some(WPARAM(1)),
                Some(point(1, 10)),
            );
            SendMessageW(
                view.hwnd,
                WM_MOUSEMOVE,
                Some(WPARAM(1)),
                Some(point(61, 10)),
            );
            SendMessageW(
                view.hwnd,
                WM_LBUTTONUP,
                Some(WPARAM(0)),
                Some(point(61, 10)),
            );
            {
                let s = view.state.lock().unwrap();
                let c = s.controller.lock().unwrap();
                assert_eq!(c.pan_x, 0.);
                assert_eq!(c.pan_y, 0.);
                assert_eq!(s.interaction.selection().unwrap().text, "Việ");
            }
            view.state.lock().unwrap().interaction.set_tool(Tool::Hand);
            SendMessageW(
                view.hwnd,
                WM_LBUTTONDOWN,
                Some(WPARAM(1)),
                Some(point(10, 10)),
            );
            SendMessageW(
                view.hwnd,
                WM_MOUSEMOVE,
                Some(WPARAM(1)),
                Some(point(50, 30)),
            );
            SendMessageW(view.hwnd, WM_PAINT, None, None);
            SendMessageW(view.hwnd, WM_LBUTTONUP, None, Some(point(50, 30)));
            {
                let s = view.state.lock().unwrap();
                let c = s.controller.lock().unwrap();
                assert_eq!((c.pan_x, c.pan_y), (20., 10.));
            }
            SendMessageW(view.hwnd, WM_RBUTTONUP, None, Some(point(60, 40)));
            assert!(events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e,InteractionEvent::ContextMenu{x,y} if *x==30. && *y==20.)));
            view.state
                .lock()
                .unwrap()
                .interaction
                .set_tool(Tool::Pointer);
            SendMessageW(
                view.hwnd,
                WM_MBUTTONDOWN,
                Some(WPARAM(16)),
                Some(point(10, 10)),
            );
            SendMessageW(
                view.hwnd,
                WM_MOUSEMOVE,
                Some(WPARAM(16)),
                Some(point(30, 10)),
            );
            SendMessageW(view.hwnd, WM_PAINT, None, None);
            SendMessageW(view.hwnd, WM_MBUTTONUP, None, Some(point(30, 10)));
            {
                let s = view.state.lock().unwrap();
                assert_eq!(s.controller.lock().unwrap().pan_x, 30.);
            }
            view.destroy().unwrap();
            DestroyWindow(parent).unwrap();
        }
    }
}

/// Trang thai noi bo cua Win32 Viewport gan voi moi HWND
pub struct ViewportHostState {
    pub controller: Arc<Mutex<ViewportController>>,
    pub scheduler: Arc<Mutex<ViewportScheduler>>,
    pub gpu_ctx: Arc<GpuContext>,
    pub presenter: Option<super::presenter::Presenter>,
    pub renderer: Option<Arc<super::document_renderer::DocumentRenderer>>,
    pub renderer_revision: u64,
    pub scene_revision: Arc<std::sync::atomic::AtomicU64>,
    pub camera_event: Option<Arc<dyn Fn(super::controller::CameraSnapshot,u64,bool) + Send + Sync>>,
    last_camera_event: std::cell::Cell<Option<(u64,super::controller::CameraSnapshot)>>,
    camera_version: std::cell::Cell<u64>,
    versioned_camera: std::cell::Cell<Option<(u64,super::controller::CameraSnapshot)>>,
    user_zoom_pending: std::cell::Cell<bool>,
    pub scene_event: Option<super::presenter::StatusCallback>,
    pub last_input: Option<super::presenter::InputStamp>,
    pub surface_config: wgpu::SurfaceConfiguration,
    pub last_mouse_pos: (f32, f32),
    pub is_space_down: bool,
    pub interaction: Interaction,
    pub pending_tool: Option<Tool>,
    pub pan_button: u32,
    pub interaction_event: Option<Arc<dyn Fn(u64, InteractionEvent) + Send + Sync>>,
}

fn emit_interaction(state: &ViewportHostState, event: InteractionEvent) {
    if let Some(notify) = &state.interaction_event {
        notify(
            state
                .scene_revision
                .load(std::sync::atomic::Ordering::Acquire),
            event,
        );
    }
}

fn clamp_camera_to_scene(state: &ViewportHostState, controller: &mut ViewportController) {
    let Some(renderer) = state.current_renderer() else { return; };
    let b = renderer.scene.bounds;
    let mut w = b.width() * renderer.scene.user_unit;
    let mut h = b.height() * renderer.scene.user_unit;
    if renderer.scene.rotation.rem_euclid(180) == 90 {
        std::mem::swap(&mut w, &mut h);
    }
    controller.clamp_to_page(w, h);
}

/// Win32 Child Viewport ket noi giua Tauri Window va GPU Surface
pub struct Win32ChildViewport {
    pub hwnd: HWND,
    owner_thread: std::thread::ThreadId,
    pub state: Arc<Mutex<ViewportHostState>>,
}

// Window Procedure cho Child HWND
unsafe extern "system" fn child_viewport_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Mutex<ViewportHostState>;

    if state_ptr.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

    let state_mutex = &*state_ptr;

    // PERF (audit 2026-09-25 §R25.GPU.27): mốc input ở WndProc, không lấy
    // WM_PAINT làm thời điểm người dùng thao tác. Bỏ mousemove không kéo.
    if measured_input_message(msg,wparam.0) {
        // PERF (audit 2026-09-27 §V27.05): mốc trước khóa, gồm cả kéo nút giữa.
        let received_at=std::time::Instant::now();
        if let Ok(mut state) = state_mutex.lock() {
            state.last_input = Some(super::presenter::InputStamp {
                sequence: state.last_input.map_or(1, |i| i.sequence + 1),
                revision: state.scene_revision.load(std::sync::atomic::Ordering::Acquire),
                at: received_at,
            });
            if crate::perf_enabled(){crate::perf_log(&format!("GPU_INPUT_RECEIVED viewport_id={} revision={} input_seq={} message={} buttons={} lock_wait_us={}",Arc::as_ptr(&state.scene_revision) as usize,state.scene_revision.load(std::sync::atomic::Ordering::Acquire),state.last_input.map_or(0,|s|s.sequence),msg,wparam.0&0xffff,received_at.elapsed().as_micros()));}
        }
    }

    match msg {
        WM_ERASEBKGND => {
            // Bo qua de tranh nhap nhay (flicker), wgpu se ve de toan bo surface
            LRESULT(1)
        }
        WM_MOUSEWHEEL => {
            let key_flags = (wparam.0 & 0xFFFF) as u32;
            let delta = ((wparam.0 >> 16) & 0xFFFF) as i16;

            let screen_x = (lparam.0 & 0xFFFF) as i16 as f32;
            let screen_y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f32;

            let mut pt = windows::Win32::Foundation::POINT {
                x: screen_x as i32,
                y: screen_y as i32,
            };
            let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut pt);

            // UIUX (audit 2026-09-25 §R25.GPU.32): giữ cả phần lẻ của WHEEL_DELTA.
            if delta == 0 { return LRESULT(0); }
            let is_ctrl = (key_flags & 0x0008) != 0;
            let is_shift = (key_flags & 0x0004) != 0;
            let is_space = (GetAsyncKeyState(VK_SPACE.0 as i32) as u16 & 0x8000) != 0;
            let mut dirty=false;
            if let Ok(state) = state_mutex.lock() {
                // UIUX (audit 2026-09-26 GPU_DIAG): lưu đúng tọa độ HWND và
                // camera trước khi gom input; nối với APPLY/PRESENT bằng input_seq.
                if crate::gpu_diagnostics_enabled() {
                    if let Ok(ctrl) = state.controller.lock() {
                        crate::perf_log(&format!("GPU_DIAG_NATIVE_WHEEL {}", serde_json::json!({
                            "viewport_id": Arc::as_ptr(&state.scene_revision) as usize,
                            "input_seq": state.last_input.map(|i| i.sequence),
                            "revision": state.scene_revision.load(std::sync::atomic::Ordering::Acquire),
                            "delta": delta, "ctrl": is_ctrl, "shift": is_shift, "space": is_space,
                            "screen_x": screen_x, "screen_y": screen_y,
                            "client_x": pt.x, "client_y": pt.y,
                            "anchor_x": pt.x as f32 / ctrl.dpr, "anchor_y": pt.y as f32 / ctrl.dpr,
                            "factor": 1.15_f32.powf(delta as f32 / 120.),
                            "path": if is_ctrl || (!is_shift && is_space) { "zoom" } else { "scroll" },
                            "tool": format!("{:?}", state.interaction.tool), "before": ctrl.snapshot()
                        })));
                    }
                }
                if is_ctrl || (!is_shift && is_space) {
                    if let Ok(mut sched) = state.scheduler.lock() {
                        let dpr = state.controller.lock().map(|c| c.dpr).unwrap_or(1.0);
                        sched.accumulate_zoom(pt.x as f32/dpr, pt.y as f32/dpr, 1.15_f32.powf(delta as f32/120.));
                        dirty=true;
                    }
                } else {
                    dirty=scroll_native_page(&state, delta, is_shift, false);
                }
            }
            if dirty { let _ = InvalidateRect(Some(hwnd), None, false); }
            LRESULT(0)
        }
        WM_MOUSEHWHEEL => {
            let delta = ((wparam.0 >> 16) & 0xFFFF) as i16;
            if delta != 0 {
                if let Ok(state) = state_mutex.lock() {
                    if scroll_native_page(&state, delta, true, true) { let _ = InvalidateRect(Some(hwnd), None, false); }
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN | WM_MBUTTONDOWN => {
            let x = (lparam.0 & 0xFFFF) as i16 as f32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f32;

            let _ = SetCapture(hwnd);
            let _ = SetFocus(Some(hwnd));

            if let Ok(mut state) = state_mutex.lock() {
                state.last_mouse_pos = (x, y);
                let space = (GetAsyncKeyState(VK_SPACE.0 as i32) as u16 & 0x8000) != 0 || state.is_space_down;
                let ctrl_handle = state.controller.clone();
                if let Ok(mut ctrl) = ctrl_handle.lock() {
                    let is_text = if state.interaction.tool == Tool::Hand || space || msg == WM_MBUTTONDOWN {
                        false
                    } else {
                        let (px, py) = ctrl.viewport_to_scene(x / ctrl.dpr, y / ctrl.dpr);
                        state.interaction.text_hit(px, py)
                    };
                    let pan = !is_text;
                    state.pan_button = if pan {
                        if msg == WM_MBUTTONDOWN {
                            16
                        } else {
                            1
                        }
                    } else {
                        0
                    };
                    ctrl.is_dragging = pan;
                    ctrl.drag_start = (x, y);
                    if crate::perf_enabled() {
                        crate::perf_log(&format!("GPU_DIAG_NATIVE_POINTER {}", serde_json::json!({
                            "viewport_id": Arc::as_ptr(&state.scene_revision) as usize,
                            "action": "down", "x": x, "y": y, "pan": pan, "space": space,
                            "button": state.pan_button, "tool": format!("{:?}", state.interaction.tool),
                            "camera": ctrl.snapshot()
                        })));
                    }
                    if !pan {
                        let (px, py) = ctrl.viewport_to_scene(x / ctrl.dpr, y / ctrl.dpr);
                        state.interaction.down(px, py, wparam.0 & 4 != 0);
                    }
                }
                emit_interaction(&state, InteractionEvent::Dismiss);
            }
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_LBUTTONUP | WM_MBUTTONUP => {
            let x = (lparam.0 & 0xFFFF) as i16 as f32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f32;
            if let Ok(mut state) = state_mutex.lock() {
                let button = if msg == WM_MBUTTONUP { 16 } else { 1 };
                if state.pan_button != 0 && state.pan_button != button {
                    return LRESULT(0);
                }
                let ctrl_handle = state.controller.clone();
                if let Ok(mut ctrl) = ctrl_handle.lock() {
                    if crate::perf_enabled() {
                        crate::perf_log(&format!("GPU_DIAG_NATIVE_POINTER {}", serde_json::json!({
                            "viewport_id": Arc::as_ptr(&state.scene_revision) as usize,
                            "action": "up", "x": x, "y": y, "button": button,
                            "dragging": ctrl.is_dragging, "last_x": state.last_mouse_pos.0,
                            "last_y": state.last_mouse_pos.1, "camera": ctrl.snapshot()
                        })));
                    }
                    if state.interaction.selecting && msg == WM_LBUTTONUP {
                        let (px, py) = ctrl.viewport_to_scene(x / ctrl.dpr, y / ctrl.dpr);
                        let event = state.interaction.up(px, py);
                        emit_interaction(&state, event);
                    }
                    ctrl.is_dragging = false;
                }
                state.pan_button = 0;
                if let Some(tool) = state.pending_tool.take() {
                    state.interaction.set_tool(tool);
                }
            }
            // ReleaseCapture gọi lại WndProc đồng bộ: phải thả khóa trước.
            let _ = ReleaseCapture();
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_LBUTTONDBLCLK => {
            let hand = state_mutex
                .lock()
                .map(|s| s.interaction.tool == Tool::Hand)
                .unwrap_or(false);
            if hand || (GetAsyncKeyState(VK_SPACE.0 as i32) as u16 & 0x8000) != 0 {
                return child_viewport_wnd_proc(hwnd, WM_LBUTTONDOWN, wparam, lparam);
            }
            let x = (lparam.0 & 0xFFFF) as i16 as f32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f32;
            if let Ok(mut state) = state_mutex.lock() {
                if state.interaction.tool == Tool::Pointer {
                    let ctrl_handle = state.controller.clone();
                    if let Ok(ctrl) = ctrl_handle.lock() {
                        let (px, py) = ctrl.viewport_to_scene(x / ctrl.dpr, y / ctrl.dpr);
                        state.interaction.select_word(px, py);
                    }
                    emit_interaction(
                        &state,
                        InteractionEvent::Selection {
                            selection: state.interaction.selection(),
                        },
                    );
                }
            }
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_RBUTTONUP => {
            if let Ok(state) = state_mutex.lock() {
                if let Ok(ctrl) = state.controller.lock() {
                    emit_interaction(
                        &state,
                        InteractionEvent::ContextMenu {
                            x: (lparam.0 & 0xFFFF) as i16 as f32 / ctrl.dpr,
                            y: ((lparam.0 >> 16) & 0xFFFF) as i16 as f32 / ctrl.dpr,
                        },
                    );
                }
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED | WM_CANCELMODE => {
            if let Ok(mut state) = state_mutex.lock() {
                if crate::perf_enabled() {
                    crate::perf_log(&format!("GPU_DIAG_NATIVE_POINTER {}", serde_json::json!({
                        "viewport_id": Arc::as_ptr(&state.scene_revision) as usize,
                        "action": "capture-ended", "message": msg, "pan_button": state.pan_button
                    })));
                }
                state.cancel_pan();
                state.interaction.selecting = false;
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let x = (lparam.0 & 0xFFFF) as i16 as f32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f32;

            if let Ok(mut state) = state_mutex.lock() {
                let is_drag = state
                    .controller
                    .lock()
                    .map(|c| c.is_dragging)
                    .unwrap_or(false);
                if is_drag {
                    let dx = x - state.last_mouse_pos.0;
                    let dy = y - state.last_mouse_pos.1;
                    state.last_mouse_pos = (x, y);

                    // Gom su kien pan qua ViewportScheduler (Milestone G3.2)
                    if let Ok(mut sched) = state.scheduler.lock() {
                        let dpr = state.controller.lock().map(|c| c.dpr).unwrap_or(1.0);
                        sched.accumulate_pan(dx / dpr, dy / dpr);
                    }

                    // Re-render frame
                    let _ = InvalidateRect(Some(hwnd), None, false);
                } else if state.interaction.selecting {
                    let ctrl_handle = state.controller.clone();
                    if let Ok(ctrl) = ctrl_handle.lock() {
                        let (px, py) = ctrl.viewport_to_scene(x / ctrl.dpr, y / ctrl.dpr);
                        state.interaction.motion(px, py, ctrl.zoom);
                    }
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            let vk = wparam.0 as u32;
            let ctrl_down = (unsafe { GetKeyState(VK_CONTROL.0 as i32) } as u16 & 0x8000) != 0;
            let alt_down = (unsafe { GetKeyState(VK_MENU.0 as i32) } as u16 & 0x8000) != 0;
            // UIUX (audit 2026-09-27 §V27.R8): HWND đã giữ focus thì DOM không
            // nhận các phím này. Dùng lại lệnh shell để Ctrl1 được hiệu chuẩn,
            // Ctrl2/PageUp/PageDown không rơi vào DefWindowProc rồi mất hút.
            if let Some(command)=keyboard_commands::viewer_command(vk,ctrl_down,alt_down){
                if let Ok(state)=state_mutex.lock(){emit_interaction(&state,InteractionEvent::ViewerCommand{command});}
                return LRESULT(0);
            }

            if vk == VK_SPACE.0 as u32 {
                if let Ok(mut state) = state_mutex.lock() {
                    state.is_space_down = true;
                }
                unsafe {
                    let hcursor = LoadCursorW(None, IDC_HAND).unwrap_or_default();
                    SetCursor(Some(hcursor));
                }
            } else if ctrl_down && (vk == b'C' as u32 || vk == b'c' as u32) {
                // Ctrl + C: Sao chép văn bản đã chọn qua frontend
                if let Ok(state) = state_mutex.lock() {
                    emit_interaction(&state, InteractionEvent::Copy);
                }
            } else if vk == VK_ESCAPE.0 as u32 {
                // Escape: Xóa vùng chọn văn bản và đóng menu/popup
                if let Ok(mut state) = state_mutex.lock() {
                    state.cancel_pan();
                    state.interaction.clear();
                    emit_interaction(&state, InteractionEvent::Dismiss);
                    emit_interaction(&state, InteractionEvent::Selection { selection: None });
                }
                let _ = InvalidateRect(Some(hwnd), None, false);
            } else {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            LRESULT(0)
        }
        WM_KEYUP => {
            let vk = wparam.0 as u32;
            if vk == VK_SPACE.0 as u32 {
                if let Ok(mut state) = state_mutex.lock() {
                    state.is_space_down = false;
                }
                unsafe {
                    let hcursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
                    SetCursor(Some(hcursor));
                }
            }
            LRESULT(0)
        }
        WM_KILLFOCUS => {
            if let Ok(mut state) = state_mutex.lock() {
                state.is_space_down = false;
            }
            LRESULT(0)
        }
        WM_SETCURSOR => {
            let mut cursor = IDC_ARROW;
            if let Ok(state) = state_mutex.lock() {
                if let Ok(ctrl) = state.controller.lock() {
                    if state.interaction.tool == Tool::Hand
                        || ctrl.is_dragging
                        || state.is_space_down
                        || (GetAsyncKeyState(VK_SPACE.0 as i32) as u16 & 0x8000) != 0
                    {
                        cursor = IDC_HAND;
                    } else {
                        let mut p = windows::Win32::Foundation::POINT::default();
                        let _ = GetCursorPos(&mut p);
                        let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut p);
                        let (x, y) =
                            ctrl.viewport_to_scene(p.x as f32 / ctrl.dpr, p.y as f32 / ctrl.dpr);
                        if state.interaction.text_hit(x, y) {
                            cursor = IDC_IBEAM;
                        }
                    }
                }
            }
            SetCursor(Some(LoadCursorW(None, cursor).unwrap_or_default()));
            LRESULT(1)
        }
        WM_SIZE => {
            let width = (lparam.0 & 0xFFFF) as u32;
            let height = ((lparam.0 >> 16) & 0xFFFF) as u32;

            if width > 0 && height > 0 {
                if let Ok(mut state) = state_mutex.lock() {
                    state.surface_config.width = width;
                    state.surface_config.height = height;

                    if let Ok(mut ctrl) = state.controller.lock() {
                        ctrl.update_surface_size(width, height, None);
                    }
                }

                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            LRESULT(0)
        }
        WM_DPICHANGED => {
            // Milestone G3.3: High-DPI & Multi-Monitor dynamic adaptation
            let dpi_x = (wparam.0 & 0xFFFF) as u32;
            let new_dpr = (dpi_x as f32) / 96.0;

            // Child HWND dùng geometry client từ React; RECT gợi ý của top-level
            // không được dùng làm kích thước surface khi HWND chưa resize.
            if let Ok(state) = state_mutex.lock() {
                if let Ok(mut ctrl) = state.controller.lock() {
                    let (width, height) = (ctrl.physical_width, ctrl.physical_height);
                    ctrl.update_surface_size(width, height, Some(new_dpr));
                }
            }

            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let _hdc = BeginPaint(hwnd, &mut ps);

            if let Ok(state) = state_mutex.lock() {
                // Tieu thu toan bo delta zoom/pan tich luy trong frame nay (Gesture Coalescing)
                if let (Ok(mut sched), Ok(mut ctrl)) =
                    (state.scheduler.lock(), state.controller.lock())
                {
                    let before = ctrl.snapshot();
                    if sched.has_pending_zoom(){state.user_zoom_pending.set(true);}
                    let _level = sched.consume_pending(&mut ctrl);
                    // PERF (audit 2026-09-26 §R35): anchor zoom/pan trực tiếp
                    // từ HWND phải chịu cùng biên trang với wheel DOM. Nếu
                    // camera trôi hoàn toàn ra ngoài page, resident compositor
                    // chỉ còn màu nền và che mất fallback.
                    clamp_camera_to_scene(&state, &mut ctrl);
                    // Chỉ ghi khi camera đổi, không ghi từng mousemove hoặc tick idle.
                    if crate::gpu_diagnostics_enabled() && before != ctrl.snapshot() {
                        crate::perf_log(&format!("GPU_DIAG_NATIVE_APPLY {}", serde_json::json!({
                            "viewport_id": Arc::as_ptr(&state.scene_revision) as usize,
                            "input_seq": state.last_input.map(|i| i.sequence),
                            "revision": state.scene_revision.load(std::sync::atomic::Ordering::Acquire),
                            "before": before, "after": ctrl.snapshot(), "dragging": ctrl.is_dragging,
                            "last_pointer_x": state.last_mouse_pos.0, "last_pointer_y": state.last_mouse_pos.1
                        })));
                    }
                }
                render_viewport_frame(&state);
            }

            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_DESTROY => {
            // Parent cũng có thể hủy child mà không đi qua command close.
            let retired = state_mutex.lock().ok().map(|mut state| {
                state
                    .scene_revision
                    .store(u64::MAX, std::sync::atomic::Ordering::Release);
                (state.presenter.take(),state.renderer.take())
            });
            if let Some((presenter,renderer))=retired{
                drop(presenter);
                if let Some(renderer)=renderer{let _=std::thread::Builder::new().name("ppe-retire-renderer".into()).spawn(move||drop(renderer));}
            }
            // Giai phong Arc khi HWND bi huy
            let old_ptr =
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *const Mutex<ViewportHostState>;
            if !old_ptr.is_null() {
                drop(Arc::from_raw(old_ptr));
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Chỉ gửi snapshot; vòng vẽ không giữ khóa input và không chặn WM_PAINT.
fn measured_input_message(msg:u32,buttons:usize)->bool {
    msg==WM_MOUSEWHEEL || msg==WM_MOUSEHWHEEL || (msg==WM_MOUSEMOVE && buttons & 0x11 != 0)
}

#[cfg(test)]
mod lifecycle_headless_tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    fn state()->ViewportHostState{
        ViewportHostState{controller:Arc::new(Mutex::new(ViewportController::new(128,96,1.))),
            scheduler:Arc::new(Mutex::new(ViewportScheduler::new())),gpu_ctx:Arc::new(GpuContext::new_sync().unwrap()),
            presenter:None,renderer:None,renderer_revision:0,scene_revision:Arc::new(AtomicU64::new(0)),
            camera_event:None,last_camera_event:std::cell::Cell::new(None),camera_version:std::cell::Cell::new(0),
            versioned_camera:std::cell::Cell::new(None),user_zoom_pending:std::cell::Cell::new(false),scene_event:None,last_input:None,
            surface_config:wgpu::SurfaceConfiguration{usage:wgpu::TextureUsages::RENDER_ATTACHMENT,format:wgpu::TextureFormat::Rgba8Unorm,width:128,height:96,
                present_mode:wgpu::PresentMode::Fifo,desired_maximum_frame_latency:1,alpha_mode:wgpu::CompositeAlphaMode::Auto,view_formats:vec![]},
            last_mouse_pos:(910.,131.),is_space_down:false,interaction:Default::default(),pending_tool:None,pan_button:0,interaction_event:None}
    }
    fn renderer(state:&ViewportHostState,content:&[u8])->Arc<super::super::document_renderer::DocumentRenderer>{
        use lopdf::{dictionary,Document,Stream};
        let mut doc=Document::with_version("1.7");let pages=doc.new_object_id();
        let stream=doc.add_object(Stream::new(dictionary!{},content.to_vec()));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),128.into(),96.into()],"Contents"=>stream,"Resources"=>dictionary!{}});
        doc.objects.insert(pages,dictionary!{"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into());let cat=doc.add_object(dictionary!{"Type"=>"Catalog","Pages"=>pages});doc.trailer.set("Root",cat);
        let cm=super::super::scene_worker::color_manager().unwrap();
        let scene=Arc::new(print_engine::scene::retained::RetainedPage::compile(&doc,1,print_engine::content::RenderOptions::viewer(),Some(&cm)).unwrap());
        Arc::new(super::super::document_renderer::DocumentRenderer::gpu(Arc::new(viewer_gpu::retained_renderer::RetainedRenderer::new(&state.gpu_ctx,scene,&cm,state.surface_config.format).unwrap())))
    }
    #[test]
    fn tool_ipc_during_captured_pan_does_not_cut_off_motion(){
        let mut s=state();s.apply_interaction_tool(Tool::Hand);s.pan_button=1;s.controller.lock().unwrap().is_dragging=true;
        // Chuỗi log thật: down Hand → blur/IPC Pointer sau15ms → move/up.
        s.apply_interaction_tool(Tool::Pointer);
        assert_eq!(s.pan_button,1,"IPC công cụ không được lấy quyền gesture đang capture");
        let mut c=s.controller.lock().unwrap();assert!(c.is_dragging);
        if c.is_dragging{c.pan(-101.,444.);}
        assert_eq!((c.pan_x,c.pan_y),(-101.,444.));drop(c);
        s.cancel_pan();assert_eq!(s.pan_button,0);assert!(!s.controller.lock().unwrap().is_dragging);
        assert_eq!(s.interaction.tool,Tool::Pointer);
    }
    #[test]
    fn scene_load_never_relabels_old_renderer_and_rejects_stale_commit(){
        let mut s=state();let first=renderer(&s,b"1 0 0 0 k 0 0 128 96 re f");
        s.begin_scene_revision(2).unwrap();s.install_renderer(2,first.clone()).unwrap();
        let a=s.frame_request().unwrap();assert_eq!(a.revision,2);assert!(Arc::ptr_eq(a.renderer.as_ref().unwrap(),&first));
        s.begin_scene_revision(4).unwrap();
        assert!(s.frame_request().is_none(),"Không được đóng dấu rev4 lên renderer trang cũ rev2");
        s.begin_scene_revision(6).unwrap();assert!(s.install_renderer(4,first).is_err());
        assert!(s.frame_request().is_none());
        let next=renderer(&s,b"0 1 0 0 k 0 0 128 96 re f");s.install_renderer(6,next.clone()).unwrap();
        let b=s.frame_request().unwrap();assert_eq!(b.revision,6);assert!(Arc::ptr_eq(b.renderer.as_ref().unwrap(),&next));
        assert!(!Arc::ptr_eq(a.renderer.as_ref().unwrap(),b.renderer.as_ref().unwrap()));
    }
    #[test]
    fn scene_change_cancels_old_gesture_and_pending_deltas(){
        let mut s=state();s.pan_button=16;s.controller.lock().unwrap().is_dragging=true;
        s.scheduler.lock().unwrap().accumulate_pan(300.,-200.);
        s.begin_scene_revision(2).unwrap();
        assert_eq!(s.pan_button,0);assert!(!s.controller.lock().unwrap().is_dragging);
        assert!(!s.scheduler.lock().unwrap().is_dirty());
        assert!(s.frame_request().is_none());assert!(s.begin_scene_revision(2).is_err());
        s.apply_interaction_tool(Tool::Hand);
        assert!(!s.controller.lock().unwrap().is_dragging,"Đổi tool không tự bắt đầu gesture mới");
    }
    #[test]
    fn camera_reply_version_orders_same_scene_changes_and_preserves_snapshot_schema(){
        let s=state();let first=s.versioned_snapshot().unwrap();
        assert_eq!(s.versioned_snapshot().unwrap().camera_version,first.camera_version);
        s.controller.lock().unwrap().anchor_zoom(30.,20.,1.15);
        let command=s.versioned_snapshot().unwrap();assert!(command.camera_version>first.camera_version);
        let input=s.camera_reply(command.camera,true);assert!(input.camera_version>command.camera_version);
        assert_eq!(input.camera,command.camera);
        let json=serde_json::to_value(input).unwrap();assert_eq!(json["cameraVersion"],input.camera_version);
        assert!(json.get("camera").is_none());assert_eq!(json["zoom"],serde_json::to_value(input.camera.zoom).unwrap());
    }
    #[test]
    fn explicit_fit_drains_older_wheel_before_applying_its_camera(){
        let s=state();s.scheduler.lock().unwrap().accumulate_zoom(80.,40.,1.5);
        s.flush_gestures_before_command().unwrap();
        assert!(!s.scheduler.lock().unwrap().is_dirty());assert!(!s.user_zoom_pending.get());
        s.controller.lock().unwrap().fit_page(128.,96.,8.);
        let fitted=s.versioned_snapshot().unwrap();
        let mut ctrl=s.controller.lock().unwrap();s.scheduler.lock().unwrap().consume_pending(&mut ctrl);
        assert_eq!(ctrl.snapshot(),fitted.camera,"Wheel cũ không được replay sau Fit");
    }
}

impl ViewportHostState {
    fn camera_reply(&self,camera:super::controller::CameraSnapshot,user_zoom:bool)->super::controller::CameraReply{
        let key=(self.scene_revision.load(std::sync::atomic::Ordering::Acquire),camera);
        if user_zoom || self.versioned_camera.get()!=Some(key){
            self.camera_version.set(self.camera_version.get().saturating_add(1));self.versioned_camera.set(Some(key));
        }
        super::controller::CameraReply{camera,camera_version:self.camera_version.get()}
    }
    pub fn versioned_snapshot(&self)->Result<super::controller::CameraReply,String>{
        let camera=self.controller.lock().map_err(|e|e.to_string())?.snapshot();
        Ok(self.camera_reply(camera,false))
    }
    pub fn flush_gestures_before_command(&self)->Result<(),String>{
        // Command đến sau input phải áp dụng sau input; không để wheel cũ
        // bị WM_PAINT replay lên một Fit vừa thực hiện.
        let mut scheduler=self.scheduler.lock().map_err(|e|e.to_string())?;
        let mut controller=self.controller.lock().map_err(|e|e.to_string())?;
        scheduler.consume_pending(&mut controller);clamp_camera_to_scene(self,&mut controller);
        self.user_zoom_pending.set(false);Ok(())
    }
    pub fn current_renderer(&self)->Option<&Arc<super::document_renderer::DocumentRenderer>>{
        // PERF/COLOR (audit 2026-09-27 §V27.R6): revision mong muốn đổi ngay,
        // nhưng renderer chỉ thuộc revision tại lúc commit. Không relabel ảnh
        // trang cũ trong khoảng compile trang mới, kể cả WM_PAINT/resize.
        self.renderer.as_ref().filter(|_|self.renderer_revision==self.scene_revision.load(std::sync::atomic::Ordering::Acquire))
    }
    pub fn begin_scene_revision(&mut self,revision:u64)->Result<(),String>{
        use std::sync::atomic::Ordering;
        if revision<=self.scene_revision.load(Ordering::Acquire){return Err("Revision scene đã hết hiệu lực".into());}
        self.scene_revision.store(revision,Ordering::Release);
        self.user_zoom_pending.set(false);
        self.cancel_pan();self.last_input=None;
        if let Ok(mut scheduler)=self.scheduler.lock(){*scheduler=ViewportScheduler::new();}
        self.interaction.clear();self.interaction.lines.clear();self.interaction.markups.clear();
        Ok(())
    }
    pub fn install_renderer(&mut self,revision:u64,renderer:Arc<super::document_renderer::DocumentRenderer>)->Result<(),String>{
        if self.scene_revision.load(std::sync::atomic::Ordering::Acquire)!=revision{return Err("Scene thuộc trang đã đóng".into());}
        self.renderer=Some(renderer);self.renderer_revision=revision;Ok(())
    }
    pub fn apply_interaction_tool(&mut self, tool: Tool) {
        // UIUX (audit 2026-09-27 §V27.R5): SetFocus(HWND) có thể làm WebView
        // blur và trả tool tạm về Pointer. Tool IPC không sở hữu capture;
        // gesture đã bắt đầu chỉ kết thúc ở up/capture-lost/Escape/đổi scene.
        crate::perf_log(&format!("GPU_WIN32_SET_TOOL {:?}", tool));
        let is_space_active = (unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(windows::Win32::UI::Input::KeyboardAndMouse::VK_SPACE.0 as i32) } as u16 & 0x8000) != 0 || self.is_space_down;
        let is_dragging = self.controller.lock().map(|c| c.is_dragging).unwrap_or(false);
        if (is_space_active || is_dragging || self.pan_button != 0) && tool == Tool::Pointer {
            crate::perf_log("GPU_WIN32_SET_TOOL kept Hand due to active Space/drag");
            self.pending_tool = Some(tool);
            return;
        }
        self.pending_tool = None;
        self.interaction.set_tool(tool);
    }
    pub fn cancel_pan(&mut self){
        self.pan_button=0;
        if let Ok(mut controller)=self.controller.lock(){controller.is_dragging=false;}
        if let Some(tool) = self.pending_tool.take() {
            self.interaction.set_tool(tool);
        }
    }
    fn frame_request(&self)->Option<super::presenter::FrameRequest>{
        let revision=self.renderer_revision;
        let renderer=self.current_renderer()?.clone();
        let mut ctrl=self.controller.lock().ok()?;
        clamp_camera_to_scene(self,&mut ctrl);
        let camera_key=(revision,ctrl.snapshot());
        let user_zoom=self.user_zoom_pending.replace(false);
        let reply=self.camera_reply(camera_key.1,user_zoom);
        if self.last_camera_event.get()!=Some(camera_key) || user_zoom{
            self.last_camera_event.set(Some(camera_key));
            if let Some(notify)=&self.camera_event{notify(camera_key.1,reply.camera_version,user_zoom);}
        }
        Some(super::presenter::FrameRequest{camera:ctrl.snapshot(),renderer:Some(renderer),revision,
            at:std::time::Instant::now(),notify:self.scene_event.clone(),input:self.last_input,
            overlays:self.interaction.overlay(ctrl.snapshot())})
    }
}
#[cfg(test)]
mod input_stamp_tests {
    #[test]
    fn stamps_left_and_middle_drag_but_not_hover(){
        use super::*;
        assert!(measured_input_message(WM_MOUSEMOVE,1));assert!(measured_input_message(WM_MOUSEMOVE,16));
        assert!(!measured_input_message(WM_MOUSEMOVE,0));assert!(measured_input_message(WM_MOUSEWHEEL,0));
    }
}
fn render_viewport_frame(state: &ViewportHostState) {
    if let Some(presenter)=&state.presenter {
        if let Some(request)=state.frame_request(){presenter.request(request);}
    }
}

impl Win32ChildViewport {
    /// Dang ky Window Class cho Native Viewport (chi can goi 1 lan)
    pub fn register_class(hinstance: HINSTANCE) {
        unsafe {
            let class = WNDCLASSW {
                style: CS_DBLCLKS,
                lpfnWndProc: Some(child_viewport_wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: Default::default(),
                hCursor: Default::default(),
                hbrBackground: Default::default(),
                lpszMenuName: windows::core::PCWSTR::null(),
                lpszClassName: w!("PPE_Native_Viewport_Window"),
            };
            let _ = RegisterClassW(&class);
        }
    }

    /// Tao Child HWND nhung vao parent_hwnd cua Tauri
    pub fn create(
        parent_hwnd: HWND,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        dpr: f32,
        gpu_ctx: Arc<GpuContext>,
    ) -> Result<Self, String> {
        let hinstance: HINSTANCE = unsafe { GetModuleHandleW(None).unwrap_or_default().into() };
        Self::register_class(hinstance);

        let child_hwnd = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("PPE_Native_Viewport_Window"),
                w!("PPE Native GPU Viewport"),
                WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                x,
                y,
                width as i32,
                height as i32,
                Some(parent_hwnd),
                None,
                Some(hinstance),
                None,
            )
        }
        .map_err(|e| format!("Khong the tao Child HWND: {:?}", e))?;

        // Tao wgpu surface
        let surface_target = Arc::new(HwndSurfaceWrapper {
            hwnd: child_hwnd,
            hinstance,
        });

        let surface = gpu_ctx
            .instance
            .create_surface(surface_target)
            .map_err(|e| {
                unsafe {
                    let _ = DestroyWindow(child_hwnd);
                }
                format!("Không tạo được wgpu Surface: {e}")
            })?;

        let caps = surface.get_capabilities(&gpu_ctx.adapter);
        if caps.formats.is_empty() || caps.alpha_modes.is_empty() {
            drop(surface);
            unsafe {
                let _ = DestroyWindow(child_hwnd);
            }
            return Err("GPU không hỗ trợ surface của cửa sổ này".into());
        }
        let surface_format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);

        // PERF (audit 2026-09-26 §R35): FIFO có thể chặn
        // `get_current_texture()` khi refinement vừa submit nhiều lệnh. Với
        // surface hỗ trợ Mailbox, ưu tiên frame mới nhất và bỏ frame trung
        // gian đã lỗi thời; máy không có Mailbox vẫn dùng FIFO an toàn.
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) {
            wgpu::PresentMode::Mailbox
        } else {
            wgpu::PresentMode::Fifo
        };
        crate::perf_log(&format!(
            "GPU_SURFACE_CAPS formats={} present_modes={:?} selected_present_mode={:?} alpha_modes={:?}",
            caps.formats.len(), caps.present_modes, present_mode, caps.alpha_modes
        ));

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: width.max(1),
            height: height.max(1),
            present_mode,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };

        // PERF (audit 2026-09-25 §R25.GPU.08): configure trước lần acquire đầu.
        surface.configure(&gpu_ctx.device, &surface_config);
        // DPR do WebView gửi là hệ số CSS→physical, có thể gồm cả zoom UI.
        // Không thay bằng DPI của HWND rồi làm camera lệch hệ tọa độ của React.
        let controller = Arc::new(Mutex::new(ViewportController::new(width, height, dpr)));
        let scheduler = Arc::new(Mutex::new(ViewportScheduler::new()));

        let scene_revision = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let presenter = match super::presenter::Presenter::new(
            gpu_ctx.clone(),
            surface,
            surface_config.clone(),
            scene_revision.clone(),
        ) {
            Ok(presenter) => presenter,
            Err(error) => {
                unsafe {
                    let _ = DestroyWindow(child_hwnd);
                }
                return Err(error);
            }
        };
        let state = Arc::new(Mutex::new(ViewportHostState {
            controller: Arc::clone(&controller),
            scheduler: Arc::clone(&scheduler),
            gpu_ctx,
            presenter: Some(presenter),
            renderer: None,
            renderer_revision: 0,
            scene_revision,
            camera_event: None,
            last_camera_event: std::cell::Cell::new(None),
            camera_version: std::cell::Cell::new(0),
            versioned_camera: std::cell::Cell::new(None),
            user_zoom_pending: std::cell::Cell::new(false),
            scene_event: None,
            last_input: None,
            surface_config,
            last_mouse_pos: (0.0, 0.0),
            is_space_down: false,
            interaction: Interaction::default(),
            pending_tool: None,
            pan_button: 0,
            interaction_event: None,
        }));

        // Luu con tro raw vao GWLP_USERDATA cua HWND
        let raw_ptr = Arc::into_raw(Arc::clone(&state));
        unsafe {
            SetWindowLongPtrW(child_hwnd, GWLP_USERDATA, raw_ptr as isize);
        }

        Ok(Self {
            hwnd: child_hwnd,
            owner_thread: std::thread::current().id(),
            state,
        })
    }

    /// Resize hoac di chuyen vi tri child viewport
    pub fn set_bounds(&self, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
        self.check_thread()?;
        unsafe {
            SetWindowPos(
                self.hwnd,
                None,
                x,
                y,
                width as i32,
                height as i32,
                SWP_NOZORDER,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Kich hoat Invalidation cap L0 - L3 (Milestone G3.2)
    pub fn trigger_invalidation(&self, level: InvalidationLevel) {
        if let Ok(state) = self.state.lock() {
            if let Ok(mut sched) = state.scheduler.lock() {
                sched.request_invalidation(level);
            }
            // HWND chưa hiện vẫn phải dựng frame đầu; WM_PAINT không bảo đảm
            // được phát cho cửa sổ đang ẩn. Camera gửi trực tiếp là thao tác nhẹ.
            render_viewport_frame(&state);
        }
        unsafe {
            let _ = InvalidateRect(Some(self.hwnd), None, false);
        }
    }

    fn check_thread(&self) -> Result<(), String> {
        if std::thread::current().id() != self.owner_thread {
            return Err("HWND phải thao tác trên luồng sở hữu".into());
        }
        Ok(())
    }

    /// Bỏ surface trước HWND, trả lỗi hủy cửa sổ về caller.
    pub fn destroy(self) -> Result<(), String> {
        self.check_thread()?;
        let presenter = {
            let mut state = self.state.lock().map_err(|e| e.to_string())?;
            state
                .scene_revision
                .store(u64::MAX, std::sync::atomic::Ordering::Release);
            state.presenter.take()
        };
        drop(presenter);
        unsafe { DestroyWindow(self.hwnd).map_err(|e| e.to_string()) }
    }

    /// PERF (audit 2026-09-27 §V27.F): ẩn và retire lease ngay trên owner;
    /// join/resource cleanup ở nền, DestroyWindow chỉ quay về đúng UI thread.
    pub fn retire(self,window:tauri::Window)->Result<(),String>{
        self.check_thread()?;
        let resources={let mut state=self.state.lock().map_err(|e|e.to_string())?;
            state.scene_revision.store(u64::MAX,std::sync::atomic::Ordering::Release);
            (state.presenter.take(),state.renderer.take())};
        unsafe{let _=windows::Win32::UI::WindowsAndMessaging::ShowWindow(self.hwnd,windows::Win32::UI::WindowsAndMessaging::SW_HIDE);}
        let pending=Arc::new(Mutex::new(Some(resources)));let worker_pending=pending.clone();
        let state=self.state.clone();let raw=self.hwnd.0 as isize;
        let result=std::thread::Builder::new().name("ppe-retire-viewport".into()).spawn(move||{
            if let Ok(mut value)=worker_pending.lock(){drop(value.take());}
            let weak=Arc::downgrade(&state);let(done,ack)=std::sync::mpsc::sync_channel(1);
            let dispatched=window.run_on_main_thread(move||{
                // Weak giữ allocation identity: HWND đã bị parent hủy hoặc
                // handle được tái dùng thì không được chạm cửa sổ khác.
                if let Some(state)=weak.upgrade(){unsafe{
                    let hwnd=HWND(raw as *mut _);
                    if GetWindowLongPtrW(hwnd,GWLP_USERDATA)==Arc::as_ptr(&state) as isize{let _=DestroyWindow(hwnd);}
                }}
                let _=done.send(());
            });
            if dispatched.is_ok(){let _=ack.recv_timeout(std::time::Duration::from_secs(30));}
            drop(state);
        });
        if let Err(error)=result{
            // Không rò HWND nếu OS không tạo được luồng cleanup; đường lỗi
            // này vẫn giữ thứ tự surface trước HWND như destroy đồng bộ.
            if let Ok(mut value)=pending.lock(){drop(value.take());}
            unsafe{let _=DestroyWindow(self.hwnd);}
            return Err(format!("Không lập được tác vụ thu hồi viewport: {error}"));
        }
        Ok(())
    }
}
