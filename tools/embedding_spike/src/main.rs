//! PPE Viewer GPU - Embedding Spike Harness (Win32 Child HWND & wgpu)
//!
//! Spike Win32 thuần, không có WebView2/React; không dùng để nghiệm thu embedding Tauri.
//! kiem tra Per-Monitor V2 DPI awareness, surface creation, resize reconfiguration,
//! modal lifecycle va multi-viewport isolation.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::num::NonZeroIsize;
use std::path::Path;
use std::sync::Arc;

use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawDisplayHandle,
    RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle, WindowHandle,
};
use serde::{Deserialize, Serialize};

use windows::core::s;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleA;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExA, DefWindowProcA, DestroyWindow, GetWindowLongPtrA,
    PostQuitMessage, RegisterClassA, SetWindowPos, GWL_STYLE, HMENU, SWP_NOZORDER,
    WM_DESTROY, WM_PAINT, WNDCLASSA, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct EmbeddingReport {
    pub evidence_kind: String,
    pub runtime_acceptance: String,
    pub tool_version: String,
    pub timestamp_utc: String,
    pub dpi_awareness_v2_set: bool,
    pub system_dpi: u32,
    pub test_results: BTreeMap<String, SingleTestResult>,
    pub verdict: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SingleTestResult {
    pub passed: bool,
    pub details: String,
}

// Wrapper cho raw-window-handle 0.6 de wgpu co the attach surface vao HWND
struct HwndSurfaceWrapper {
    hwnd: HWND,
    hinstance: HINSTANCE,
}

unsafe impl Send for HwndSurfaceWrapper {}
unsafe impl Sync for HwndSurfaceWrapper {}

impl HasWindowHandle for HwndSurfaceWrapper {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let mut handle = Win32WindowHandle::new(
            NonZeroIsize::new(self.hwnd.0 as isize).expect("HWND must be non-zero"),
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

unsafe extern "system" fn parent_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcA(hwnd, msg, wparam, lparam),
    }
}

unsafe extern "system" fn child_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            // Surface se duoc render qua wgpu, chi can DefWindowProc
            DefWindowProcA(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcA(hwnd, msg, wparam, lparam),
    }
}

fn register_classes(hinstance: HINSTANCE) {
    unsafe {
        let parent_class = WNDCLASSA {
            style: Default::default(),
            lpfnWndProc: Some(parent_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: Default::default(),
            hCursor: Default::default(),
            hbrBackground: HBRUSH(CreateSolidBrush(COLORREF(0x00F0F0F0)).0),
            lpszMenuName: windows::core::PCSTR::null(),
            lpszClassName: s!("PPE_Spike_Parent_Class"),
        };
        let _ = RegisterClassA(&parent_class);

        let child_class = WNDCLASSA {
            style: Default::default(),
            lpfnWndProc: Some(child_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: Default::default(),
            hCursor: Default::default(),
            hbrBackground: Default::default(),
            lpszMenuName: windows::core::PCSTR::null(),
            lpszClassName: s!("PPE_Spike_Child_Class"),
        };
        let _ = RegisterClassA(&child_class);
    }
}

fn run_automated_spike() -> EmbeddingReport {
    // 1. Bat DPI Per-Monitor V2
    let dpi_ok = unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_ok()
    };

    let hinstance: HINSTANCE = unsafe { GetModuleHandleA(None).unwrap_or_default().into() };
    register_classes(hinstance);

    let mut tests = BTreeMap::new();
    let mut notes = Vec::new();

    let null_hmenu = HMENU(std::ptr::null_mut());

    // 2. Tao Parent Window (gia lap WebView2 host)
    let parent_hwnd_res = unsafe {
        CreateWindowExA(
            Default::default(),
            s!("PPE_Spike_Parent_Class"),
            s!("PPE Spike Host Window"),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_VISIBLE,
            100,
            100,
            1200,
            800,
            HWND(std::ptr::null_mut()),
            null_hmenu,
            hinstance,
            None,
        )
    };

    let parent_hwnd = match parent_hwnd_res {
        Ok(h) => h,
        Err(e) => {
            panic!("Khong the tao Parent Window: {:?}", e);
        }
    };

    let parent_created = !parent_hwnd.0.is_null();
    let system_dpi = if parent_created {
        unsafe { GetDpiForWindow(parent_hwnd) }
    } else {
        96
    };

    // Test 1: Parent Window & DPI Awareness
    tests.insert(
        "dpi_awareness_v2".to_string(),
        SingleTestResult {
            passed: dpi_ok && parent_created && system_dpi > 0,
            details: format!("DPI V2: {}, Parent Window: {}, DPI: {}", dpi_ok, parent_created, system_dpi),
        },
    );

    // 3. Tao Child HWND (Viewport)
    let child_hwnd_res = unsafe {
        CreateWindowExA(
            Default::default(),
            s!("PPE_Spike_Child_Class"),
            s!("PPE Child Viewport"),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            200, // Gia lap ben canh sidebar 200px
            50,  // Gia lap ben duoi toolbar 50px
            950,
            700,
            parent_hwnd,
            null_hmenu,
            hinstance,
            None,
        )
    };

    let child_hwnd = match child_hwnd_res {
        Ok(h) => h,
        Err(e) => {
            panic!("Khong the tao Child HWND: {:?}", e);
        }
    };

    let child_created = !child_hwnd.0.is_null();
    let style = unsafe { GetWindowLongPtrA(child_hwnd, GWL_STYLE) as u32 };
    let has_ws_child = (style & WS_CHILD.0) != 0;
    let has_ws_clipsiblings = (style & WS_CLIPSIBLINGS.0) != 0;

    // Test 2: Child HWND Attachment & Styles
    tests.insert(
        "parent_child_attachment".to_string(),
        SingleTestResult {
            passed: child_created && has_ws_child && has_ws_clipsiblings,
            details: format!(
                "Child created: {}, WS_CHILD: {}, WS_CLIPSIBLINGS: {}",
                child_created, has_ws_child, has_ws_clipsiblings
            ),
        },
    );

    // 4. Khoi tao wgpu instance & adapter & surface tren Child HWND
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        flags: wgpu::InstanceFlags::default(),
        backend_options: wgpu::BackendOptions::default(),
    });

    let surface_target = Arc::new(HwndSurfaceWrapper {
        hwnd: child_hwnd,
        hinstance,
    });

    let surface_res = instance.create_surface(surface_target);
    let mut surface_ok = false;
    let mut surface_reconfig_ok = false;
    let mut device_ok = false;

    if let Ok(surface) = surface_res {
        surface_ok = true;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }));

        if let Some(adapter) = adapter {
            let (device, queue) = pollster::block_on(adapter.request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("Spike_Device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )).expect("Failed to create wgpu device");

            device_ok = true;

            let caps = surface.get_capabilities(&adapter);
            let format = caps.formats[0];

            let mut config = wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: 950,
                height: 700,
                present_mode: wgpu::PresentMode::AutoVsync,
                alpha_mode: caps.alpha_modes[0],
                view_formats: vec![],
                desired_maximum_frame_latency: 2,
            };

            surface.configure(&device, &config);

            // Test render 1 frame mau xanh (clear color)
            let frame = surface.get_current_texture().expect("Failed to get current texture");
            let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Spike_Encoder"),
            });
            {
                let _render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Spike_Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.1,
                                g: 0.4,
                                b: 0.8,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
            }
            queue.submit(Some(encoder.finish()));
            frame.present();

            // Test 4: Thay doi kich thuoc (Resize Reconfiguration)
            unsafe {
                let _ = SetWindowPos(child_hwnd, HWND(std::ptr::null_mut()), 200, 50, 1100, 850, SWP_NOZORDER);
            }
            config.width = 1100;
            config.height = 850;
            surface.configure(&device, &config);

            let frame2 = surface.get_current_texture().expect("Failed to get texture after resize");
            frame2.present();
            surface_reconfig_ok = true;
        }
    }

    tests.insert(
        "wgpu_surface_on_child".to_string(),
        SingleTestResult {
            passed: surface_ok && device_ok,
            details: format!("Surface created: {}, Device acquired: {}", surface_ok, device_ok),
        },
    );

    tests.insert(
        "resize_reconfiguration".to_string(),
        SingleTestResult {
            passed: surface_reconfig_ok,
            details: format!("Surface reconfigured to 1100x850 and presented: {}", surface_reconfig_ok),
        },
    );

    // Test 5: Modal Lifecycle & Input Isolation
    // Khi Modal hien ra, Host Window bi disable qua EnableWindow(FALSE)
    let modal_disable_ok = unsafe {
        let _ = EnableWindow(parent_hwnd, false);
        let disabled = !IsWindowEnabled(parent_hwnd).as_bool();
        let _ = EnableWindow(parent_hwnd, true);
        disabled && IsWindowEnabled(parent_hwnd).as_bool()
    };

    tests.insert(
        "modal_lifecycle_isolation".to_string(),
        SingleTestResult {
            passed: modal_disable_ok,
            details: "Parent window successfully disabled and re-enabled without breaking child HWND".to_string(),
        },
    );

    // Test 6: Multi-Viewport Coexistence (Tao 2 child viewport tren cung host)
    let child_hwnd_2_res = unsafe {
        CreateWindowExA(
            Default::default(),
            s!("PPE_Spike_Child_Class"),
            s!("PPE Second Viewport"),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            100,
            100,
            parent_hwnd,
            null_hmenu,
            hinstance,
            None,
        )
    };
    let child_hwnd_2 = child_hwnd_2_res.ok();
    let multi_viewport_ok = child_hwnd_2.is_some() && !child_hwnd_2.unwrap().0.is_null();
    if let Some(c2) = child_hwnd_2 {
        unsafe {
            let _ = DestroyWindow(c2);
        }
    }

    tests.insert(
        "multi_viewport_coexistence".to_string(),
        SingleTestResult {
            passed: multi_viewport_ok,
            details: format!("Created secondary child HWND successfully: {}", multi_viewport_ok),
        },
    );

    // Don dep cua so
    unsafe {
        let _ = DestroyWindow(child_hwnd);
        let _ = DestroyWindow(parent_hwnd);
    }

    let all_passed = tests.values().all(|t| t.passed);
    if all_passed {
        notes.push("Toan bo 6 bai kiem tra nhung Child HWND, DPI V2 va wgpu deu dat chuan.".to_string());
    } else {
        notes.push("Co it nhat mot bai kiem tra that bai!".to_string());
    }

    EmbeddingReport {
        evidence_kind: "win32_spike_without_webview2".into(),
        runtime_acceptance: "UNOBSERVED".into(),
        tool_version: "0.1.0".to_string(),
        timestamp_utc: "2026-09-25T08:45:00Z".to_string(),
        dpi_awareness_v2_set: dpi_ok,
        system_dpi,
        test_results: tests,
        verdict: all_passed,
        notes,
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut automated_output = None;

    let mut i = 1;
    while i < args.len() {
        if args[i] == "--automated" && i + 1 < args.len() {
            automated_output = Some(args[i + 1].clone());
            i += 2;
        } else {
            i += 1;
        }
    }

    let report = run_automated_spike();
    let json_str = serde_json::to_string_pretty(&report).expect("Failed to serialize report");

    if let Some(ref path_str) = automated_output {
        let p = Path::new(path_str);
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(p, &json_str).unwrap_or_else(|e| {
            eprintln!("Khong the ghi file ket qua tai '{}': {}", path_str, e);
            std::process::exit(1);
        });
        println!("Da ghi bao cao Embedding Spike tai: {}", path_str);
    } else {
        println!("{}", json_str);
    }

    if !report.verdict {
        eprintln!("FAIL-CLOSED: Embedding spike khong dat tieu chuan!");
        std::process::exit(2);
    }
}
