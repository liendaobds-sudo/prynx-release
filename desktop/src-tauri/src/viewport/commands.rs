//! IPC viewport: lease theo cửa sổ/view/generation, HWND chỉ thao tác trên UI thread.
use super::{controller::CameraReply, win32_host::Win32ChildViewport};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex},
};
use tauri::Emitter;
use tauri::Window;
use viewer_gpu::GpuContext;
use windows::Win32::Foundation::HWND;
struct Lease {
    generation: u64,
    viewport: Option<Win32ChildViewport>,
}
// PERF (audit 2026-09-25 §R25.GPU.08–09): registry chỉ được truy cập trên UI thread.
thread_local! {
    static VIEWS: RefCell<HashMap<(String, String), Lease>> = RefCell::new(HashMap::new());
    static WATCHED_WINDOWS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}
static GPU_CONTEXT: LazyLock<Mutex<Option<Arc<GpuContext>>>> = LazyLock::new(|| Mutex::new(None));
/// Bỏ context dùng chung sau lỗi device/surface terminal; viewport hiện tại sẽ
/// báo lỗi, còn lần mở lại sau đó tạo adapter/device mới thay vì giữ context hỏng.
pub(crate) fn invalidate_gpu_context(gpu:u64,reason: &str) {
    let retired=GPU_CONTEXT.lock().ok().and_then(|mut slot|{
        if slot.as_ref().is_some_and(|ctx|ctx.identity()==gpu){slot.take()}else{None}
    });
    super::scene_cache::retire_gpu_resources(gpu);
    if retired.is_some(){crate::perf_log(&format!("GPU_CONTEXT_INVALIDATED gpu={gpu} reason={reason}"));}
}
#[cfg(test)]
mod recovery_tests {
    #[test]
    fn old_device_error_cannot_retire_newer_context(){
        use super::*;
        let old=Arc::new(GpuContext::new_sync().unwrap());let new=Arc::new(GpuContext::new_sync().unwrap());
        *GPU_CONTEXT.lock().unwrap()=Some(new.clone());
        invalidate_gpu_context(old.identity(),"v27-old-error");
        assert!(Arc::ptr_eq(GPU_CONTEXT.lock().unwrap().as_ref().unwrap(),&new));
        invalidate_gpu_context(new.identity(),"v27-current-error");assert!(GPU_CONTEXT.lock().unwrap().is_none());
    }
}
fn gpu_context() -> Result<Arc<GpuContext>, String> {
    let mut slot = GPU_CONTEXT.lock().map_err(|e| e.to_string())?;
    if let Some(ctx) = &*slot {
        return Ok(ctx.clone());
    }
    let ctx =
        Arc::new(GpuContext::new_sync().map_err(|e| format!("Không khởi tạo được GPU: {e}"))?);
    let gpu_id=ctx.identity();ctx.set_timing_sink(Arc::new(move|stage,result|match result{
        Ok(sample)=>crate::perf_log(&format!("GPU_STAGE_TIMING gpu={} stage={} gpu_span_us={:.3} submit_to_callback_us={:.3}",gpu_id,stage,sample.gpu_span_us,sample.submit_to_callback_us)),
        Err(error)=>crate::perf_log(&format!("GPU_TIMING_ERROR gpu={} stage={} error={}",gpu_id,stage,error)),
    }));
    crate::perf_log(&format!(
        "GPU_ADAPTER name={} backend={:?} device_type={:?} vendor={} device={} driver={} driver_info={}",
        ctx.adapter_info.name,
        ctx.adapter_info.backend,
        ctx.adapter_info.device_type,
        ctx.adapter_info.vendor,
        ctx.adapter_info.device,
        ctx.adapter_info.driver,
        ctx.adapter_info.driver_info
    ));
    *slot = Some(ctx.clone());
    Ok(ctx)
}
async fn on_ui<T: Send + 'static>(
    window: &Window,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(action());
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "Luồng UI đã dừng trước khi xử lý viewport".to_string())?
}
fn with_view<T>(
    owner: &str,
    view_id: &str,
    generation: u64,
    action: impl FnOnce(&Win32ChildViewport) -> Result<T, String>,
) -> Result<T, String> {
    VIEWS.with(|views| {
        let views = views.borrow();
        let lease = views
            .get(&(owner.to_owned(), view_id.to_owned()))
            .ok_or("Viewport không tồn tại")?;
        if lease.generation != generation {
            return Err("Phiên viewport đã hết hiệu lực".into());
        }
        action(lease.viewport.as_ref().ok_or("Viewport đã đóng")?)
    })
}
fn snapshot(view: &Win32ChildViewport) -> Result<CameraReply, String> {
    let state = view.state.lock().map_err(|e| e.to_string())?;
    state.versioned_snapshot()
}
fn validate_bounds(width: u32, height: u32, dpr: f32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > i32::MAX as u32
        || height > i32::MAX as u32
        || !dpr.is_finite()
        || dpr <= 0.0
    {
        return Err("Kích thước hoặc DPR viewport không hợp lệ".into());
    }
    Ok(())
}
/// PERF (audit 2026-09-25 §R25.GPU.15): revision chốt trước parse; kết quả cũ không gắn lên HWND mới.
#[tauri::command]
pub async fn load_native_gpu_scene(
    window: Window,
    view_id: String,
    generation: u64,
    revision: u64,
    file_path: String,
    page: usize,
    document_token: Option<String>,
) -> Result<CameraReply, String> {
    use std::sync::atomic::Ordering;
    if revision == 0 || revision == u64::MAX || page == 0 || crate::is_sensitive_path(&file_path) {
        return Err("Yêu cầu scene không hợp lệ".into());
    }
    let owner = window.label().to_owned();
    let begin_owner = owner.clone();
    let begin_id = view_id.clone();
    let (gpu, format, current) = on_ui(&window, move || {
        with_view(&begin_owner, &begin_id, generation, |view| {
            let mut s = view.state.lock().map_err(|e| e.to_string())?;
            s.begin_scene_revision(revision)?;
            // COLOR (audit 2026-09-27 §V27.R6): có thể giữ tài nguyên trang cũ
            // để retire an toàn, nhưng current_renderer/frame_request chỉ cho
            // phát frame khi revision đã bind khớp scene mong muốn. Frame cũ
            // tuyệt đối không được cấp proof cho trang đang compile.
            let result = (
                s.gpu_ctx.clone(),
                s.surface_config.format,
                s.scene_revision.clone(),
            );
            drop(s);
            Ok(result)
        })
    })
    .await?;
    let ready = tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let renderer=super::scene_cache::load(&gpu,format,file_path,page,document_token.unwrap_or_default(),revision,current)?;
        crate::perf_log(&format!(
            "GPU_SCENE_READY revision={revision} page={page} prepare_ms={}",
            started.elapsed().as_millis()
        ));
        Ok::<_,String>(renderer)
    })
    .await
    .map_err(|e| e.to_string())??;
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            {
                let mut s = view.state.lock().map_err(|e| e.to_string())?;
                if s.scene_revision.load(Ordering::Acquire) != revision {
                    return Err("Scene thuộc trang đã đóng".into());
                }
                let b = ready.scene.bounds;
                let mut w = b.width() * ready.scene.user_unit;
                let mut h = b.height() * ready.scene.user_unit;
                if ready.scene.rotation.rem_euclid(180) == 90 {
                    std::mem::swap(&mut w, &mut h);
                }
                {
                    let mut c = s.controller.lock().map_err(|e| e.to_string())?;
                    let vw = c.physical_width as f32 / c.dpr;
                    let vh = c.physical_height as f32 / c.dpr;
                    c.zoom = ((vw - 32.).max(1.) / w)
                        .min((vh - 32.).max(1.) / h)
                        .clamp(0.05, 64.);
                    c.pan_x = (vw - w * c.zoom) / 2.;
                    c.pan_y = (vh - h * c.zoom) / 2.;
                }
                s.install_renderer(revision,ready)?;
            }
            view.trigger_invalidation(
                print_engine::scene::invalidation::InvalidationLevel::L3DocumentEdit,
            );
            snapshot(view)
        })
    })
    .await
}
#[tauri::command]
pub async fn open_native_gpu_viewport(
    window: Window,
    view_id: String,
    generation: u64,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    dpr: f32,
) -> Result<CameraReply, String> {
    validate_bounds(width, height, dpr)?;
    if view_id.is_empty() || generation == 0 {
        return Err("Lease viewport không hợp lệ".into());
    }
    let gpu = tauri::async_runtime::spawn_blocking(gpu_context)
        .await
        .map_err(|e| e.to_string())??;
    let owner = window.label().to_string();
    let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let event_owner = owner.clone();
    let event_window = window.clone();
    on_ui(&window, move || {
        if WATCHED_WINDOWS.with(|owners| owners.borrow_mut().insert(event_owner.clone())) {
            event_window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    VIEWS.with(|views| {
                        views
                            .borrow_mut()
                            .retain(|(owner, _), _| owner != &event_owner)
                    });
                    WATCHED_WINDOWS.with(|owners| {
                        owners.borrow_mut().remove(&event_owner);
                    });
                }
            });
        }
        if width > gpu.device.limits().max_texture_dimension_2d
            || height > gpu.device.limits().max_texture_dimension_2d
        {
            return Err("Viewport vượt kích thước surface mà GPU hỗ trợ".into());
        }
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let key = (owner, view_id.clone());
            if let Some(old) = views.get(&key) {
                if generation < old.generation
                    || (generation == old.generation && old.viewport.is_none())
                {
                    return Err("Lệnh mở thuộc phiên viewport đã đóng".into());
                }
                if generation == old.generation {
                    return snapshot(old.viewport.as_ref().unwrap());
                }
            }
            let view =
                Win32ChildViewport::create(HWND(parent as *mut _), x, y, width, height, dpr, gpu)?;
            let emitter=event_window.clone();let event_id=view_id.clone();
            let camera_revision=view.state.lock().map_err(|e|e.to_string())?.scene_revision.clone();
            view.state.lock().map_err(|e|e.to_string())?.camera_event=Some(Arc::new(move|camera,camera_version,user_initiated_zoom|{
                let revision=camera_revision.load(std::sync::atomic::Ordering::Acquire);
                let _=emitter.emit("ppe-native-camera",serde_json::json!({"viewId":event_id,"generation":generation,"revision":revision,"camera":camera,
                    "cameraVersion":camera_version,"userInitiatedZoom":user_initiated_zoom}));
            }));
            let emitter=event_window.clone();let event_id=view_id.clone();
            let visibility_window=event_window.clone();let visibility_owner=visibility_window.label().to_string();
            let status_sequence=Arc::new(std::sync::atomic::AtomicU64::new(0));
            view.state.lock().map_err(|e|e.to_string())?.scene_event=Some(Arc::new(move|revision,error,content_ready,surface|{
                // COLOR (audit 2026-09-27 §V27.C3/F): khi mất proof/lỗi GPU,
                // không chờ JS đang bận mới bỏ HWND lỗi khỏi trên bitmap PPE.
                let sequence=status_sequence.fetch_add(1,std::sync::atomic::Ordering::AcqRel)+1;
                if !content_ready || error.is_some(){
                    let latest=status_sequence.clone();let owner=visibility_owner.clone();let id=event_id.clone();
                    let _=visibility_window.run_on_main_thread(move||{
                        if latest.load(std::sync::atomic::Ordering::Acquire)!=sequence{return;}
                        let _=with_view(&owner,&id,generation,|view|{
                            let matches=view.state.lock().map_err(|e|e.to_string())?.scene_revision.load(std::sync::atomic::Ordering::Acquire)==revision;
                            if matches{super::visibility::set_child_visibility(view.hwnd,false)?;}Ok(())
                        });
                    });
                }
                let _=emitter.emit("ppe-native-status",serde_json::json!({"viewId":event_id,"generation":generation,"revision":revision,"error":error,"contentReady":content_ready,"surface":surface}));
            }));
            let emitter=event_window.clone();let event_id=view_id.clone();
            view.state.lock().map_err(|e|e.to_string())?.interaction_event=Some(Arc::new(move|revision,event|{
                let _=emitter.emit("ppe-native-interaction",serde_json::json!({"viewId":event_id,"generation":generation,"revision":revision,"event":event}));
            }));
            let camera = snapshot(&view)?;
            if let Some(old) = views.remove(&key).and_then(|l| l.viewport) {
                old.retire(event_window.clone())?;
            }
            views.insert(
                key,
                Lease {
                    generation,
                    viewport: Some(view),
                },
            );
            Ok(camera)
        })
    })
    .await
}

#[tauri::command]
pub async fn resize_native_gpu_viewport(
    window: Window,
    view_id: String,
    generation: u64,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    dpr: f32,
) -> Result<(), String> {
    validate_bounds(width, height, dpr)?;
    let owner = window.label().to_string();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            {
                let state = view.state.lock().map_err(|e| e.to_string())?;
                let limit = state.gpu_ctx.device.limits().max_texture_dimension_2d;
                if width > limit || height > limit {
                    return Err("Viewport vượt kích thước surface mà GPU hỗ trợ".into());
                }
            }
            if let Err(error) = view.set_bounds(x, y, width, height) {
                crate::perf_log(&format!(
                    "GPU_VIEWPORT_BOUNDS_ERROR x={} y={} width={} height={} error={}",
                    x, y, width, height, error
                ));
                return Err(error);
            }
            let state = view.state.lock().map_err(|e| e.to_string())?;
            state
                .controller
                .lock()
                .map_err(|e| e.to_string())?
                .update_surface_size(width, height, Some(dpr));
            drop(state);
            view.trigger_invalidation(
                print_engine::scene::invalidation::InvalidationLevel::L0Camera,
            );
            Ok(())
        })
    })
    .await
}
#[tauri::command]
pub async fn set_native_gpu_viewport_visibility(
    window: Window,
    view_id: String,
    generation: u64,
    visible: bool,
    revision: Option<u64>,
) -> Result<(), String> {
    let owner = window.label().to_owned();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            if visible && revision.is_some_and(|value| view.state.lock().map(|s|
                s.scene_revision.load(std::sync::atomic::Ordering::Acquire)!=value).unwrap_or(true)) {
                let cur = view.state.lock().map(|s| s.scene_revision.load(std::sync::atomic::Ordering::Acquire)).unwrap_or(0);
                crate::perf_log(&format!(
                    "GPU_VIEWPORT_VISIBILITY_REJECTED view={} generation={} req_rev={:?} cur_rev={}",
                    view_id, generation, revision, cur
                ));
                return Ok(()); // ACK cũ không được làm hiện trang mới trước first-present.
            }
            // PERF (audit 2026-09-25 §R25.GPU.26): WebView2 là sibling đã có trước.
            // ACK phải bao gồm việc đưa HWND lên trên, không chỉ bật WS_VISIBLE.
            super::visibility::set_child_visibility(view.hwnd, visible)?;
            use windows::Win32::UI::WindowsAndMessaging::{GetParent, GetTopWindow};
            let top = unsafe { GetParent(view.hwnd).and_then(|p| GetTopWindow(Some(p))) }
                .map(|hwnd| hwnd == view.hwnd)
                .unwrap_or(false);
            crate::perf_log(&format!(
                "GPU_VIEWPORT_VISIBILITY view={view_id} generation={generation} visible={visible} top_sibling={top}"
            ));
            if visible {
                view.trigger_invalidation(
                    print_engine::scene::invalidation::InvalidationLevel::L0Camera,
                );
            }
            Ok(())
        })
    })
    .await
}
#[tauri::command]
pub async fn set_native_gpu_viewport_zoom(
    window: Window,
    view_id: String,
    generation: u64,
    zoom: f32,
    cursor_x: Option<f32>,
    cursor_y: Option<f32>,
    revision: Option<u64>,
) -> Result<CameraReply, String> {
    if !zoom.is_finite()
        || zoom <= 0.0
        || cursor_x.is_some_and(|x| !x.is_finite())
        || cursor_y.is_some_and(|y| !y.is_finite())
    {
        return Err("Tọa độ zoom không hợp lệ".into());
    }
    crate::perf_log(&format!(
        "GPU_IPC_SET_ZOOM view={} gen={} zoom={} rev={:?}",
        view_id, generation, zoom, revision
    ));
    let owner = window.label().to_string();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            if revision.is_some_and(|expected| {
                let current = view
                    .state
                    .lock()
                    .map(|s| s.scene_revision.load(std::sync::atomic::Ordering::Acquire))
                    .unwrap_or(u64::MAX);
                if current != expected {
                    crate::perf_log(&format!(
                        "GPU_DIAG_NATIVE_REJECT {}",
                        serde_json::json!({
                            "command": "set_zoom",
                            "view_id": view_id,
                            "generation": generation,
                            "expected_revision": expected,
                            "current_revision": current,
                            "reason": "stale-scene"
                        })
                    ));
                    true
                } else {
                    false
                }
            }) {
                return Err("Zoom thuộc trang cũ".into());
            }
            {
                let state = view.state.lock().map_err(|e| e.to_string())?;
                state.flush_gestures_before_command()?;
                let mut ctrl = state.controller.lock().map_err(|e| e.to_string())?;
                let cx = cursor_x.unwrap_or(ctrl.physical_width as f32 / ctrl.dpr / 2.0);
                let cy = cursor_y.unwrap_or(ctrl.physical_height as f32 / ctrl.dpr / 2.0);
                let factor = zoom / ctrl.zoom;
                let before = ctrl.snapshot();
                ctrl.anchor_zoom(cx, cy, factor);
                if let Some(renderer) = state.current_renderer() {
                    let b = renderer.scene.bounds;
                    let mut page_w = b.width() * renderer.scene.user_unit;
                    let mut page_h = b.height() * renderer.scene.user_unit;
                    if renderer.scene.rotation.rem_euclid(180) == 90 {
                        std::mem::swap(&mut page_w, &mut page_h);
                    }
                    ctrl.clamp_to_page(page_w, page_h);
                }
                if crate::perf_enabled() {
                    crate::perf_log(&format!("GPU_DIAG_NATIVE_COMMAND {}", serde_json::json!({
                        "viewport_id": std::sync::Arc::as_ptr(&state.scene_revision) as usize,
                        "view_id": view_id, "generation": generation, "revision": revision,
                        "command": "set_zoom", "requested_zoom": zoom, "cursor_x": cx, "cursor_y": cy,
                        "cursor_x_source": if cursor_x.is_some() { "explicit" } else { "viewport-center" },
                        "cursor_y_source": if cursor_y.is_some() { "explicit" } else { "viewport-center" },
                        "before": before, "after": ctrl.snapshot()
                    })));
                }
            }
            view.trigger_invalidation(
                print_engine::scene::invalidation::InvalidationLevel::L0Camera,
            );
            snapshot(view)
        })
    })
    .await
}

#[tauri::command]
pub async fn fit_native_gpu_viewport_page(
    window: Window,
    view_id: String,
    generation: u64,
    revision: u64,
    max_zoom: Option<f32>,
) -> Result<CameraReply, String> {
    use std::sync::atomic::Ordering;
    if max_zoom.is_some_and(|v|!v.is_finite() || v<=0.){return Err("Giới hạn Smart Fit không hợp lệ".into());}
    let owner = window.label().to_string();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            let state = view.state.lock().map_err(|e| e.to_string())?;
            if state.scene_revision.load(Ordering::Acquire) != revision { return Err("Fit thuộc trang cũ".into()); }
            let renderer = state.current_renderer().ok_or("Scene chưa sẵn sàng")?;
            state.flush_gestures_before_command()?;
            let b = renderer.scene.bounds;
            let mut w = b.width() * renderer.scene.user_unit;
            let mut h = b.height() * renderer.scene.user_unit;
            if renderer.scene.rotation.rem_euclid(180) == 90 { std::mem::swap(&mut w, &mut h); }
            let mut controller = state.controller.lock().map_err(|e| e.to_string())?;
            let before = controller.snapshot();
            controller.fit_page_with_limit(w, h, 32.0,max_zoom);
            if crate::perf_enabled() {
                crate::perf_log(&format!("GPU_DIAG_NATIVE_COMMAND {}", serde_json::json!({
                    "viewport_id": std::sync::Arc::as_ptr(&state.scene_revision) as usize,
                    "view_id": view_id, "generation": generation, "revision": revision,
                    "command": "fit_page", "before": before, "after": controller.snapshot()
                })));
            }
            drop(controller); drop(state);
            view.trigger_invalidation(print_engine::scene::invalidation::InvalidationLevel::L0Camera);
            snapshot(view)
        })
    }).await
}
#[tauri::command]
pub async fn get_native_gpu_viewport_camera(
    window: Window,
    view_id: String,
    generation: u64,
    revision: Option<u64>,
) -> Result<CameraReply, String> {
    let owner = window.label().to_string();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            if revision.is_some_and(|expected| view.state.lock().map(|s| s.scene_revision.load(std::sync::atomic::Ordering::Acquire) != expected).unwrap_or(true)) {
                return Err("Camera thuộc trang cũ".into());
            }
            snapshot(view)
        })
    })
    .await
}
#[tauri::command]
pub async fn trigger_native_gpu_viewport_invalidation(
    window: Window,
    view_id: String,
    generation: u64,
    revision: Option<u64>,
    level: String,
) -> Result<(), String> {
    use print_engine::scene::invalidation::InvalidationLevel;
    let level = match level.as_str() {
        "L0" => InvalidationLevel::L0Camera,
        "L1" => InvalidationLevel::L1ViewState,
        "L2" => InvalidationLevel::L2ResourceProfile,
        "L3" => InvalidationLevel::L3DocumentEdit,
        _ => return Err("Mức invalidation không hợp lệ".into()),
    };
    let owner = window.label().to_string();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            if let Some(expected) = revision {
                let current = view.state.lock().map_err(|e| e.to_string())?
                    .scene_revision.load(std::sync::atomic::Ordering::Acquire);
                if current != expected { return Ok(()); }
            }
            view.trigger_invalidation(level);
            Ok(())
        })
    })
    .await
}
/// Hợp đồng tương tác v1: phải ACK trước khi hiện native ở công cụ con trỏ.
#[tauri::command]
pub async fn set_native_gpu_viewport_interaction(
    window: Window,
    view_id: String,
    generation: u64,
    revision: u64,
    tool: Option<super::interaction::Tool>,
    text: Option<Vec<super::interaction::TextLine>>,
    markups: Option<Vec<super::interaction::Markup>>,
    clear_selection: Option<bool>,
) -> Result<(), String> {
    use super::interaction::{Interaction, InteractionEvent, Rect};
    use std::sync::atomic::Ordering;
    if let Some(lines) = &text {
        Interaction::validate_lines(lines)?;
    }
    if markups
        .as_ref()
        .is_some_and(|ms| ms.iter().any(|m| !m.bounds.valid()))
    {
        return Err("Tọa độ đánh dấu không hợp lệ".into());
    }
    let owner = window.label().to_owned();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            let mut s = view.state.lock().map_err(|e| e.to_string())?;
            if revision != s.scene_revision.load(Ordering::Acquire) {
                return Err("Tương tác thuộc trang cũ".into());
            }
            if let Some(tool) = tool {
                s.apply_interaction_tool(tool);
                if crate::perf_enabled() {
                    crate::perf_log(&format!("GPU_DIAG_NATIVE_TOOL {}", serde_json::json!({
                        "viewport_id": std::sync::Arc::as_ptr(&s.scene_revision) as usize,
                        "view_id": view_id, "generation": generation, "revision": revision,
                        "tool": format!("{:?}", tool), "pan_button":s.pan_button,
                        "dragging":s.controller.lock().map(|c|c.is_dragging).unwrap_or(false)
                    })));
                }
            }
            if let Some(mut lines) = text {
                let renderer = s.current_renderer().ok_or("Scene chưa sẵn sàng")?;
                let m = renderer.scene.page_to_view(1., 0., 0.);
                for line in &mut lines {
                    if line.pdf_coordinates {
                        for g in &mut line.glyphs {
                            let r = g.bounds;
                            let pts = [
                                (r.x, r.y),
                                (r.x + r.width, r.y),
                                (r.x, r.y + r.height),
                                (r.x + r.width, r.y + r.height),
                            ];
                            let xs = pts.map(|(x, y)| m.a * x + m.c * y + m.e);
                            let ys = pts.map(|(x, y)| m.b * x + m.d * y + m.f);
                            let x = xs.into_iter().fold(f32::INFINITY, f32::min);
                            let y = ys.into_iter().fold(f32::INFINITY, f32::min);
                            g.bounds = Rect {
                                x,
                                y,
                                width: xs.into_iter().fold(f32::NEG_INFINITY, f32::max) - x,
                                height: ys.into_iter().fold(f32::NEG_INFINITY, f32::max) - y,
                            };
                        }
                        line.pdf_coordinates = false;
                    }
                }
                Interaction::validate_lines(&lines)?;
                // Thứ tự đọc theo dòng hiển thị, giống lớp chữ của Viewer hiện hành.
                lines.sort_by(|a, b| {
                    let a = a.glyphs.first().map(|g| g.bounds).unwrap_or_default();
                    let b = b.glyphs.first().map(|g| g.bounds).unwrap_or_default();
                    if (a.y - b.y).abs() > 3. {
                        a.y.total_cmp(&b.y)
                    } else {
                        a.x.total_cmp(&b.x)
                    }
                });
                s.interaction.clear();
                s.interaction.lines = lines;
            }
            if let Some(markups) = markups {
                s.interaction.markups = markups;
            }
            if clear_selection == Some(true) {
                s.interaction.clear();
                if let Some(notify) = &s.interaction_event {
                    notify(revision, InteractionEvent::Selection { selection: None });
                }
            }
            crate::perf_log(&format!(
                "GPU_INTERACTION_CONFIG revision={revision} tool={:?} text_lines={} markups={}",
                s.interaction.tool,
                s.interaction.lines.len(),
                s.interaction.markups.len()
            ));
            drop(s);
            view.trigger_invalidation(
                print_engine::scene::invalidation::InvalidationLevel::L0Camera,
            );
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn set_native_gpu_viewport_exclusions(
    window: Window,
    view_id: String,
    generation: u64,
    holes: Vec<super::interaction::Rect>,
) -> Result<(), String> {
    let owner = window.label().to_owned();
    on_ui(&window, move || {
        with_view(&owner, &view_id, generation, |view| {
            let (w, h) = {
                let s = view.state.lock().map_err(|e| e.to_string())?;
                (s.surface_config.width, s.surface_config.height)
            };
            super::window_region::set_exclusions(view.hwnd, w, h, &holes)
        })
    })
    .await
}

#[tauri::command]
pub async fn close_native_gpu_viewport(
    window: Window,
    view_id: String,
    generation: u64,
) -> Result<(), String> {
    let owner = window.label().to_string();
    let retire_window=window.clone();
    on_ui(&window, move || {
        VIEWS.with(|views| {
            let mut views = views.borrow_mut();
            let lease = views.entry((owner, view_id)).or_insert(Lease {
                generation,
                viewport: None,
            });
            if generation < lease.generation {
                return Ok(());
            }
            if let Some(view) = lease.viewport.take() {
                view.retire(retire_window.clone())?;
            }
            lease.generation = generation;
            Ok(())
        })
    })
    .await
}
