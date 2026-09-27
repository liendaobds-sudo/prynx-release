//! PERF (audit 2026-09-25 §R25.GPU.22): present camera độc lập với refinement.
//! Luôn giữ overview toàn trang và các detail gần đây; không đổi qua ảnh PDFium khi zoom.
use super::document_renderer::DocumentRenderer;
use super::{
    controller::CameraSnapshot,
    detail_cache::DetailCache,
    refinement::{RefineRequest, Refined, Refiner},
};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{sync_channel, SyncSender},
    Arc, Mutex,
};
use viewer_gpu::{
    resident_present::{ResidentCompositor, ResidentFrame},
    GpuContext,
};
#[path = "refinement_policy.rs"]
pub(super) mod policy;
use policy::{RefinementDecision, RefinementPolicy};
#[derive(Clone,Copy,serde::Serialize)]
pub struct SurfaceProof {pub epoch:u64,pub width:u32,pub height:u32,pub dpr:f32}
pub type StatusCallback = Arc<dyn Fn(u64, Option<String>, bool, Option<SurfaceProof>) + Send + Sync>;
#[derive(Clone, Copy)]
pub struct InputStamp {
    pub sequence: u64,
    /// R34.07: input thuộc scene nào; sequence toàn HWND không đủ khi đổi trang.
    pub revision: u64,
    pub at: std::time::Instant,
}
#[derive(Clone)]
pub struct FrameRequest {
    pub camera: CameraSnapshot,
    pub renderer: Option<Arc<DocumentRenderer>>,
    pub revision: u64,
    pub at: std::time::Instant,
    pub notify: Option<StatusCallback>,
    pub input: Option<InputStamp>,
    pub overlays: Vec<super::overlay::OverlayRect>,
}
pub struct Presenter {
    latest: Arc<Mutex<Option<FrameRequest>>>,
    wake: SyncSender<()>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    surface_released: std::sync::mpsc::Receiver<()>,
    #[cfg(test)]
    probe: Arc<Mutex<PresenterProbe>>,
}
// Chỉ có trong binary test: quan sát CHÍNH vòng Presenter, không chép scheduler
// sang harness khác và không đặt instrumentation vào binary ứng dụng.
#[cfg(test)]
#[derive(Clone,Default)]
struct PresenterProbe {
    camera:Option<CameraSnapshot>,settled:bool,presented_frames:u64,
    refined_frames:u64,submitted_batches:u64,peak_details:usize,
    presenter_cpu_us:u64,credit_wait_us:u128,batch_sizes:Vec<usize>,batch_elapsed_us:Vec<u128>,
}
#[cfg(test)]
fn presenter_thread_cpu_us()->u64{
    use windows::Win32::{Foundation::FILETIME,System::Threading::{GetCurrentThread,GetThreadTimes}};
    let(mut created,mut exit,mut kernel,mut user)=(FILETIME::default(),FILETIME::default(),FILETIME::default(),FILETIME::default());
    unsafe{GetThreadTimes(GetCurrentThread(),&mut created,&mut exit,&mut kernel,&mut user).unwrap();}
    let ticks=|t:FILETIME|(u64::from(t.dwHighDateTime)<<32)|u64::from(t.dwLowDateTime);
    (ticks(kernel)+ticks(user))/10
}
// PERF (audit 2026-09-27 §V27.F): tín hiệu chỉ phát SAU khi surface đã drop,
// kể cả unwind. Việc đợi refiner/CPU không thuộc vòng đời HWND nữa.
struct ReleaseAfterDrop<T>{value:Option<T>,released:Option<SyncSender<()>>}
impl<T> std::ops::Deref for ReleaseAfterDrop<T>{type Target=T;fn deref(&self)->&T{self.value.as_ref().unwrap()}}
impl<T> Drop for ReleaseAfterDrop<T>{fn drop(&mut self){drop(self.value.take());if let Some(tx)=self.released.take(){let _=tx.send(());}}}
// Ngân sách lát GPU để camera có lượt xen vào, không phải cap số primitive,
// worker hay chất lượng. Phần còn lại luôn tiếp tục sau completion thật.
fn next_refine_batch_size(previous:usize,completed_us:u128)->usize{
    ((previous as u128*2_000/completed_us.max(1)) as usize).clamp(1,32)
}

/// Giới hạn resident texture theo RAM và áp lực hiện tại. Máy mạnh không bị
/// hạ xuống mức của máy yếu; chỉ giảm khi RAM thực sự ít hoặc đang thiếu.
fn detail_cache_budget(ctx:&GpuContext,resident:u64) -> Option<u64> {
    let memory=crate::system_memory_status();
    super::detail_cache::budget_for_memory(memory.map_or(0,|s|s.total_bytes),memory.map_or(0,|s|s.available_bytes),super::scene_cache::gpu_memory_snapshot(ctx),resident)
}

/// Chỉ hủy refinement khi camera đã rời xa mục tiêu đang dựng. Pan nhỏ vẫn để
/// worker hoàn tất để frame cũ được đưa vào resident cache và phủ vùng kế bên.
fn camera_change_requires_cancel(from: CameraSnapshot, to: CameraSnapshot) -> bool {
    if from.viewport_width != to.viewport_width
        || from.viewport_height != to.viewport_height
        || (from.dpr - to.dpr).abs() > 0.001
    {
        return true;
    }
    if !from.zoom.is_finite() || !to.zoom.is_finite() || from.zoom <= 0.0 || to.zoom <= 0.0 {
        return true;
    }
    let zoom_distance = (to.zoom / from.zoom).ln().abs();
    let pan_distance = (to.pan_x - from.pan_x).hypot(to.pan_y - from.pan_y);
    let viewport = from.viewport_width.min(from.viewport_height).max(1) as f32;
    zoom_distance > 0.45 || pan_distance > viewport * 0.75
}

impl Presenter {
    pub fn new(
        ctx: Arc<GpuContext>,
        surface: wgpu::Surface<'static>,
        mut config: wgpu::SurfaceConfiguration,
        revision: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        let latest: Arc<Mutex<Option<FrameRequest>>> = Arc::new(Mutex::new(None));
        let queue = latest.clone();
        let (wake, rx) = sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let refiner = Refiner::new(ctx.clone(), config.format, stopped.clone(), wake.clone(), revision.clone())?;
        let (surface_released_tx,surface_released)=sync_channel(1);
        let completion_wake=wake.clone();
        // PERF (audit 2026-09-27 §V27.R7): A/B cùng binary đã kiểm cả present
        // thừa và nhịp thu hồi credit. Nhánh lịch sử chỉ có ở binary test.
        #[cfg(not(test))]
        let present_intermediate_batches=false;
        #[cfg(test)]
        let present_intermediate_batches=std::env::var("PRYNX_PRESENTER_AB").as_deref()==Ok("legacy");
        #[cfg(not(test))]
        let cooperative_credit_poll=true;
        #[cfg(test)]
        let cooperative_credit_poll=!matches!(std::env::var("PRYNX_PRESENTER_AB").as_deref(),Ok("legacy")|Ok("candidate"));
        #[cfg(test)]
        let probe=Arc::new(Mutex::new(PresenterProbe::default()));
        #[cfg(test)]
        let observer=probe.clone();
        let thread=std::thread::Builder::new().name("ppe-native-present".into()).spawn(move||{
            let surface=ReleaseAfterDrop{value:Some(surface),released:Some(surface_released_tx)};
            crate::perf_log(&format!("GPU_TIMING_CAPABILITY enabled={} displayed=unobserved",ctx.gpu_timing_supported()));
            let compositor=ResidentCompositor::new(&ctx,config.format);
            let overlays=super::overlay::OverlayPainter::new(&ctx,config.format);
            let mut current:Option<FrameRequest>=None;let mut base:Option<Arc<ResidentFrame>>=None;
            // PERF (audit 2026-09-26 §R35): giữ frame theo LRU thay vì FIFO.
            // Khi người dùng quay lại vùng A, frame A vừa được dùng sẽ còn
            // trong cache và không phải quay về overview mờ rồi dựng lại.
            let mut details=DetailCache::new(detail_cache_budget(&ctx,0));
            let mut refinement_policy=RefinementPolicy::default();
            let mut pending:Option<Refined>=None;let mut busy=false;let mut active_refine_camera:Option<CameraSnapshot>=None;let mut completed=None;let mut dirty=false;let mut notified=None;let mut failed=None;let mut last_present_camera:Option<CameraSnapshot>=None;let mut last_settled_camera:Option<CameraSnapshot>=None;
            let mut reported_input=0;let mut frame_sequence=0u64;let mut surface_epoch=1u64;let mut surface_dpr:Option<f32>=None;
            let gpu_in_flight=Arc::new(AtomicBool::new(false));
            let gpu_completion=Arc::new(Mutex::new(None::<(usize,u128)>));let mut batch_size=8usize;
            let presenter_id=Arc::as_ptr(&revision) as usize;
            #[cfg(test)]
            let probe_cpu_start=presenter_thread_cpu_us();
            while !stopped.load(Ordering::Acquire){
                ctx.device.poll(wgpu::Maintain::Poll);
                #[cfg(test)]
                {let mut probe=observer.lock().unwrap();probe.camera=current.as_ref().map(|job|job.camera);probe.presented_frames=frame_sequence;
                 probe.peak_details=probe.peak_details.max(details.len());probe.presenter_cpu_us=presenter_thread_cpu_us().saturating_sub(probe_cpu_start);
                 probe.settled=current.as_ref().is_some_and(|job|completed==Some(job.camera)) && !busy && pending.is_none() && !gpu_in_flight.load(Ordering::Acquire) && !dirty;}
                if let Some((count,micros))=gpu_completion.lock().ok().and_then(|mut value|value.take()){
                    batch_size=next_refine_batch_size(count,micros);
                    #[cfg(test)]
                    {let mut probe=observer.lock().unwrap();probe.batch_sizes.push(count);probe.batch_elapsed_us.push(micros);}
                }
                if gpu_in_flight.load(Ordering::Acquire){
                    #[cfg(test)]
                    let wait_at=std::time::Instant::now();
                    // Chỉ khi có credit GPU đang chờ mới poll/yield. Timeout
                    // 1ms chen vào lát2ms làm batch rơi về1 mãi; Wait trên
                    // device lại có thể giữ fence khóa queue của camera.
                    // Idle bên dưới vẫn ngủ theo event, không spin nền.
                    if cooperative_credit_poll{let _=rx.try_recv();std::thread::yield_now();}
                    else{let _=rx.recv_timeout(std::time::Duration::from_millis(1));}
                    #[cfg(test)]
                    {observer.lock().unwrap().credit_wait_us+=wait_at.elapsed().as_micros();}
                }
                else if pending.is_none(){let _=rx.recv_timeout(std::time::Duration::from_millis(50));}else{let _=rx.try_recv();}
                if let Some(job) = queue.lock().ok().and_then(|mut q| q.take()) {
                    if job.revision == revision.load(Ordering::Acquire) {
                        let scene_changed = current.as_ref().map(|old| old.revision) != Some(job.revision);
                        let cancel_refinement = active_refine_camera.is_some_and(|old| camera_change_requires_cancel(old, job.camera));
                        if scene_changed || cancel_refinement {
                            refiner.invalidate();
                            // Chỉ bỏ kết quả pending khi scene/camera đã rời xa
                            // mục tiêu; pan nhỏ vẫn giữ để bổ sung cache.
                            // stale; ACK để worker thu hồi pool ngay.
                            if let Some(old) = pending.take() { let _ = old.done.send(()); busy = false; }
                            crate::perf_log(&format!("GPU_PRESENTER_CANCEL_REFINE rev={} active_cam_zoom={:?} new_cam_zoom={:.4} scene_changed={}",
                                job.revision, active_refine_camera.map(|c| c.zoom), job.camera.zoom, scene_changed));
                            active_refine_camera = None;
                        }
                        if scene_changed {
                            base = job.renderer.as_ref().and_then(|r| r.overview()); details.clear(); refinement_policy.reset(); completed = None; notified = None; failed = None;
                            if let Some(old) = pending.take() { let _ = old.done.send(()); busy = false; }
                            crate::perf_log(&format!("GPU_PRESENTER_SCENE_CHANGED rev={} base_ready={}", job.revision, base.is_some()));
                        }
                        crate::perf_log(&format!("GPU_PRESENTER_REQUEST rev={} zoom={:.4} pan=({:.2},{:.2}) queue_age_us={}",
                            job.revision, job.camera.zoom, job.camera.pan_x, job.camera.pan_y, job.at.elapsed().as_micros()));
                        current = Some(job); dirty = true;
                    } else {
                        crate::perf_log(&format!("GPU_PRESENTER_REQUEST_DROPPED_REV_MISMATCH job_rev={} cur_rev={}",
                            job.revision, revision.load(Ordering::Acquire)));
                    }
                }
                while let Ok(result) = refiner.receive.try_recv() {
                    match result {
                        Ok(value) if value.revision == revision.load(Ordering::Acquire) && value.generation == refiner.current_generation() => {
                            crate::perf_log(&format!("GPU_PRESENTER_REFINE_RECV_OK rev={} gen={} draws={} encode_us={} commands={}",
                                value.revision, value.generation, value.stats.draws, value.stats.encode_us, value.commands.len()));
                            pending = Some(value);
                        },
                        Ok(value) => {
                            crate::perf_log(&format!("GPU_PRESENTER_REFINE_RECV_DISCARDED rev={} gen={} cur_gen={} cur_rev={}",
                                value.revision, value.generation, refiner.current_generation(), revision.load(Ordering::Acquire)));
                            let _ = value.done.send(()); busy = false; active_refine_camera = None;
                        },
                        Err((rev, e)) => {
                            busy = false; active_refine_camera = None;
                            if e == "Frame đã bị thay thế" {
                                crate::perf_log(&format!("GPU_SCENE_REFINE_CANCEL revision={rev} reason=camera_or_scene_changed"));
                            } else {
                                crate::perf_log(&format!("GPU_PRESENTER_REFINE_ERROR rev={rev} err={e}"));
                                if let Some(job) = current.as_ref().filter(|j| j.revision == rev) {
                                    if base.is_none() {
                                        // Chỉ khi chưa có overview base thì lỗi mới làm hỏng việc mở scene ban đầu.
                                        failed = Some(rev);
                                        if let Some(notify) = &job.notify { notify(rev, Some(e.clone()), false, None); }
                                        log::error!("PPE initial overview error: {e}");
                                    } else {
                                        // Đã có base overview: lỗi refinement chỉ là không tải được lớp chi tiết độ nét cao;
                                        // không được set failed và không được ẩn HWND, presenter vẫn tiếp tục render base và cache ở 60fps.
                                        log::warn!("PPE refinement non-fatal error: {e}");
                                    }
                                }
                            }
                        },
                    }
                }
                let Some(job) = &current else { continue; };
                if job.revision!=revision.load(Ordering::Acquire) || failed==Some(job.revision){continue;}
                let camera=job.camera;
                if let Some(error) = ctx.take_device_error() {
                    crate::perf_log(&format!("GPU_DEVICE_ERROR error={} action=clear_frame_resources", error));
                    // PERF (audit 2026-09-27 §V27.R7): kiểm cả khi chỉ còn
                    // offscreen/idle, không đợi một frame visible mới báo lỗi.
                    refiner.invalidate();if let Some(work)=pending.take(){let _=work.done.send(());}
                    gpu_in_flight.store(false,Ordering::Release);
                    if let Ok(mut completion)=gpu_completion.lock(){*completion=None;}
                    failed=Some(job.revision);busy=false;
                    if let Some(notify)=&job.notify{notify(job.revision,Some(error),false,None);}
                    super::commands::invalidate_gpu_context(ctx.identity(),"uncaptured_device_error");
                    dirty = true;
                    continue;
                }
                if let Some(work)=pending.as_mut(){
                    // PERF (audit 2026-09-27 §V27.B3): chỉ một lát refine đang
                    // chờ GPU; submit nhanh không được lấp queue bằng cả trang.
                    if !work.commands.is_empty() && !gpu_in_flight.load(Ordering::Acquire){
                        let batch:Vec<_>=work.commands.drain(..work.commands.len().min(batch_size)).collect();
                        let count=batch.len();let began=std::time::Instant::now();gpu_in_flight.store(true,Ordering::Release);
                        #[cfg(test)]
                        {observer.lock().unwrap().submitted_batches+=1;}
                        // PERF (audit 2026-09-25 §G4): submit không chờ GPU trong
                        // vòng present. `Maintain::Wait` ở mỗi batch biến pan/
                        // wheel thành chuỗi stall CPU→GPU; completion vẫn được
                        // đồng bộ ở refinement khi cần readback.
                        let timing_revision=work.revision;let timing_id=presenter_id;
                        ctx.submit_measured(batch,move|sample|match sample{
                            Ok(s)=>crate::perf_log(&format!("GPU_QUEUE_TIMING presenter_id={} revision={} stage=refine_batch gpu_span_us={:.3} submit_to_callback_us={:.3} displayed=false",timing_id,timing_revision,s.gpu_span_us,s.submit_to_callback_us)),
                            Err(e)=>crate::perf_log(&format!("GPU_TIMING_ERROR revision={} error={}",timing_revision,e)),
                        });
                        let credit=gpu_in_flight.clone();let completion=gpu_completion.clone();let wake=completion_wake.clone();
                        ctx.queue.on_submitted_work_done(move||{
                            if let Ok(mut value)=completion.lock(){*value=Some((count,began.elapsed().as_micros()));}
                            credit.store(false,Ordering::Release);let _=wake.try_send(());
                        });
                        // PERF (audit 2026-09-27 §V27.R7): batch chỉ ghi texture
                        // offscreen chưa đưa vào cache, nên pixel đang hiển thị
                        // chưa đổi. Không present lại hàng chục lần ảnh cũ;
                        // camera/overlay mới và commit refinement vẫn đặt dirty.
                        if present_intermediate_batches{dirty=true;}
                    }
                    if work.commands.is_empty(){
                        let work=pending.take().unwrap();
                        #[cfg(test)]
                        {observer.lock().unwrap().refined_frames+=1;}
                        crate::perf_log(&format!("GPU_SCENE_REFINE revision={} zoom={:.4} pan=({:.2},{:.2}) ready_us={} encode_us={} draws={} culled={} overview={} material_us={} material_builds={} coverage_bytes={} clip_us={} clip_pixels={} partial={} raster_w={} raster_h={} clip_cache_reused={}",
                            work.revision,work.camera.zoom,work.camera.pan_x,work.camera.pan_y,work.at.elapsed().as_micros(),work.stats.encode_us,work.stats.draws,work.stats.culled,work.overview,work.stats.material_prepare_us,work.stats.material_builds,work.stats.coverage_bytes,work.stats.clip_us,work.stats.clip_pixels,work.partial,work.frame.texture.width(),work.frame.texture.height(),work.stats.clip_cache_reused));
                        if !work.stats.content_proof.is_verified(){
                            crate::perf_log(&format!("GPU_SCENE_REFINE_UNVERIFIED revision={} proof={:?}",work.revision,work.stats.content_proof));
                            completed=Some(work.camera);
                            if let Some(notify)=&job.notify{notify(job.revision,None,false,None);}
                        }else if work.overview{
                            let frame=Arc::new(work.frame);
                            if let Some(renderer)=&job.renderer{renderer.remember_overview(frame.clone());}
                            base=Some(frame);
                        }else{
                            let refined_camera=work.camera;
                            details.set_budget(detail_cache_budget(&ctx,details.bytes()));
                            let evicted=details.insert_with_coverage(work.frame,work.coverage);
                            crate::perf_log(&format!("GPU_DETAIL_CACHE action=insert entries={} resident_bytes={} budget_bytes={} evicted={}",details.len(),details.bytes(),details.budget().unwrap_or(u64::MAX),evicted));
                            // Công việc có thể hoàn tất sau khi input mới đã vào
                            // queue; nếu vùng partial đã đủ phủ kín camera thì đánh dấu completed.
                            let is_complete = if work.partial {
                                if let Some(renderer) = &job.renderer {
                                    let matrix = renderer.raster_matrix(renderer.scene.page_to_view(
                                        refined_camera.zoom * refined_camera.dpr,
                                        refined_camera.pan_x * refined_camera.dpr,
                                        refined_camera.pan_y * refined_camera.dpr,
                                    ));
                                    details.touch(matrix, refined_camera.viewport_width, refined_camera.viewport_height)
                                } else {
                                    false
                                }
                            } else {
                                true
                            };
                            completed = if is_complete { Some(refined_camera) } else { None };
                        }
                        let _=work.done.send(());busy=false;active_refine_camera=None;dirty=true;
                    }
                }
                // PERF (audit 2026-09-27 §V27.R4): dùng cùng policy với test
                // headless; đủ detail thì idle, ROI không tiến triển thì full
                // PPE. Không lấy overview hoặc epsilon làm bằng chứng đã nét.
                if !busy && completed!=Some(camera){
                    if let Some(renderer)=&job.renderer {
                        let matrix=renderer.raster_matrix(renderer.scene.page_to_view(camera.zoom*camera.dpr,camera.pan_x*camera.dpr,camera.pan_y*camera.dpr));
                        let decision=if base.is_none(){RefinementDecision::Render{region:None,recovering:false}}
                            else{refinement_policy.plan(&mut details,matrix,camera.viewport_width,camera.viewport_height,renderer.supports_partial_refinement())};
                        match decision {
                            RefinementDecision::Idle => {
                                completed = Some(camera);
                                crate::perf_log(&format!("GPU_DETAIL_CACHE action=hit entries={} zoom={:.4} (idle, no refine needed)", details.len(), camera.zoom));
                            }
                            RefinementDecision::Render { region, recovering } => {
                                crate::perf_log(&format!("GPU_DETAIL_CACHE action=miss entries={} zoom={:.4} region={:?} recovering={} -> submitting refine",
                                    details.len(), camera.zoom, region, recovering));
                                if recovering { crate::perf_log(&format!("GPU_REFINE_RECOVERY revision={} reason=no_coverage_progress action=full_ppe", job.revision)); }
                                busy = refiner.submit(RefineRequest { frame: job.clone(), overview: base.is_none(), generation: 0, region });
                                if busy { active_refine_camera = Some(camera); }
                            }
                        }
                    }
                }
                if !dirty{continue;}let Some(base)=base.as_ref() else{continue;};
                let surface_changed=camera.viewport_width!=config.width || camera.viewport_height!=config.height || surface_dpr.is_some_and(|dpr|(dpr-camera.dpr).abs()>=0.001);
                surface_dpr=Some(camera.dpr);
                if surface_changed{
                    surface_epoch=surface_epoch.wrapping_add(1);notified=None;
                    if let Some(notify)=&job.notify{notify(job.revision,None,false,None);}
                    config.width=camera.viewport_width;config.height=camera.viewport_height;surface.configure(&ctx.device,&config);
                }
                let acquire_started=std::time::Instant::now();
                let output=match surface.get_current_texture(){
                    Ok(v)=>v,
                    Err(wgpu::SurfaceError::Lost|wgpu::SurfaceError::Outdated)=>{
                        surface_epoch=surface_epoch.wrapping_add(1);notified=None;
                        if let Some(notify)=&job.notify{notify(job.revision,None,false,None);}
                        crate::perf_log("GPU_SURFACE_ERROR kind=lost_or_outdated action=reconfigure");
                        surface.configure(&ctx.device,&config);
                        match surface.get_current_texture(){Ok(v)=>v,Err(e)=>{failed=Some(job.revision);if let Some(notify)=&job.notify{notify(job.revision,Some(format!("GPU acquire sau configure: {e}")),false,None);}continue;}}
                    },Err(wgpu::SurfaceError::Timeout)=>{crate::perf_log("GPU_SURFACE_ERROR kind=timeout action=skip");continue;},
                    Err(e)=>{crate::perf_log(&format!("GPU_SURFACE_ERROR kind=terminal error={e}"));super::commands::invalidate_gpu_context(ctx.identity(),"surface_terminal");failed=Some(job.revision);if let Some(notify)=&job.notify{notify(job.revision,Some(format!("GPU acquire: {e}")),false,None);}continue;},
                };
                let acquire_us=acquire_started.elapsed().as_micros();
                if acquire_us>=8_000 {
                    crate::perf_log(&format!("GPU_SURFACE_ACQUIRE wait_us={} present_mode={:?}",acquire_us,config.present_mode));
                }
                let Some(renderer)=&job.renderer else{continue;};
                let matrix=renderer.raster_matrix(renderer.scene.page_to_view(camera.zoom*camera.dpr,camera.pan_x*camera.dpr,camera.pan_y*camera.dpr));
                let now=std::time::Instant::now();let mut e=ctx.device.create_command_encoder(&Default::default());
                let detail_refs=details.frames();
                if let Err(error)=compositor.encode_layers(&ctx,&mut e,&output.texture.create_view(&Default::default()),matrix,base,&detail_refs,config.width,config.height){
                    failed=Some(job.revision);if let Some(notify)=&job.notify{notify(job.revision,Some(error.to_string()),false,None);}continue;
                }
                overlays.encode(&ctx,&mut e,&output.texture.create_view(&Default::default()),config.width,config.height,&job.overlays);
                let timing_revision=job.revision;let timing_id=presenter_id;let timing_frame=frame_sequence+1;
                ctx.submit_measured([e.finish()],move|sample|match sample{
                    Ok(s)=>crate::perf_log(&format!("GPU_QUEUE_TIMING presenter_id={} revision={} frame_id={} stage=resident gpu_span_us={:.3} submit_to_callback_us={:.3} displayed=false",timing_id,timing_revision,timing_frame,s.gpu_span_us,s.submit_to_callback_us)),
                    Err(e)=>crate::perf_log(&format!("GPU_TIMING_ERROR revision={} error={}",timing_revision,e)),
                });
                if stopped.load(Ordering::Acquire) || job.revision!=revision.load(Ordering::Acquire){continue;}
                // `present()` thành công chưa đủ để coi frame là có nội dung:
                // camera có thể đã trôi hoàn toàn ra ngoài overview/detail,
                // khi đó shader chỉ trả màu nền xám. Không commit texture rỗng
                // và không ACK visibility; frame tốt cuối cùng/fallback vẫn
                // giữ quyền hiển thị.
                let base_overlaps = viewer_gpu::resident_present::raster_overlaps(
                    base.matrix, base.texture.width(), base.texture.height(),
                    matrix, config.width, config.height,
                );
                let detail_overlaps = detail_refs.iter().any(|frame| {
                    viewer_gpu::resident_present::raster_overlaps(
                        frame.matrix, frame.texture.width(), frame.texture.height(),
                        matrix, config.width, config.height,
                    )
                });
                if !base_overlaps && !detail_overlaps {
                    if let Some(notify)=&job.notify{notify(job.revision,None,false,None);}notified=None;
                    crate::perf_log(&format!("GPU_SCENE_PRESENT_NO_COVERAGE revision={} zoom={:.4} pan=({:.2},{:.2}) surface=({}, {})",
                        job.revision, camera.zoom, camera.pan_x, camera.pan_y, config.width, config.height));
                    dirty = false;
                    continue;
                }
                let encode_submit_us=now.elapsed().as_micros();let present_at=std::time::Instant::now();
                output.present();dirty=false;
                let call_present_us=present_at.elapsed().as_micros();frame_sequence=frame_sequence.wrapping_add(1);
                if crate::perf_enabled(){crate::perf_log(&format!("GPU_FRAME_TIMING presenter_id={} frame_id={} revision={} input_seq={} acquire_us={} encode_submit_us={} call_present_us={} request_age_us={} displayed=false",presenter_id,frame_sequence,job.revision,job.input.map_or(0,|s|s.sequence),acquire_us,encode_submit_us,call_present_us,job.at.elapsed().as_micros()));}
                // Đo từ lúc nhận WM input tới gọi present, mỗi input đúng một mẫu;
                // không trộn khung refinement sau đó vào độ trễ tương tác.
                if let Some(input)=job.input.filter(|i|i.sequence>reported_input && i.revision==job.revision){
                    reported_input=input.sequence;
                    crate::perf_log(&format!("GPU_INPUT_PRESENT revision={} input_revision={} input_seq={} message_to_present_us={} zoom={:.4} pan=({:.2},{:.2})",job.revision,input.revision,input.sequence,input.at.elapsed().as_micros(),camera.zoom,camera.pan_x,camera.pan_y));
                    if crate::gpu_diagnostics_enabled() {
                        crate::perf_log(&format!("GPU_DIAG_NATIVE_PRESENT {}", serde_json::json!({
                            "revision": job.revision, "input_seq": input.sequence,
                            "camera": camera, "detail_count": details.len(), "refining": busy,
                            "detail_complete_for_camera": completed == Some(camera),
                            "message_to_present_us": input.at.elapsed().as_micros(),
                            "acquire_us": acquire_us
                        })));
                    }
                }
                if crate::gpu_diagnostics_enabled() {
                    let is_settled = completed == Some(camera) && !busy;
                    if is_settled && last_settled_camera != Some(camera) {
                        crate::perf_log(&format!("GPU_DIAG_NATIVE_PRESENT {}", serde_json::json!({
                            "revision": job.revision,
                            "input_seq": job.input.map(|i| i.sequence),
                            "camera": camera,
                            "detail_count": details.len(),
                            "refining": false,
                            "detail_complete_for_camera": true,
                            "message_to_present_us": job.input.map(|i| i.at.elapsed().as_micros()),
                            "acquire_us": acquire_us
                        })));
                        last_settled_camera = Some(camera);
                    } else if !is_settled {
                        last_settled_camera = None;
                    }
                }
                if crate::gpu_diagnostics_enabled() && last_present_camera != Some(camera) {
                    let detail_summary: Vec<_> = detail_refs.iter().map(|frame| serde_json::json!({
                        "width": frame.texture.width(), "height": frame.texture.height(),
                        "matrix": frame.matrix,
                        "overlap": viewer_gpu::resident_present::raster_overlaps(
                            frame.matrix, frame.texture.width(), frame.texture.height(),
                            matrix, config.width, config.height),
                        "density": viewer_gpu::resident_present::raster_sample_density(frame.matrix, matrix),
                    })).collect();
                    crate::perf_log(&format!("GPU_DIAG_NATIVE_PRESENT_FRAME {}", serde_json::json!({
                        "revision": job.revision, "camera": camera,
                        "surface": {"width": config.width, "height": config.height},
                        "base": {"width": base.texture.width(), "height": base.texture.height(), "matrix": base.matrix},
                        "details": detail_summary,
                        "target_matrix": matrix,
                    })));
                    last_present_camera = Some(camera);
                }
                if notified!=Some(job.revision){
                    notified=Some(job.revision);
                    if let Some(notify)=&job.notify{
                        notify(job.revision,None,true,Some(SurfaceProof{epoch:surface_epoch,width:config.width,height:config.height,dpr:camera.dpr}));
                    }
                    crate::perf_log(&format!("GPU_PRESENTER_STATUS_ACK rev={} epoch={} content_ready=true size=({},{}) dpr={}",
                        job.revision, surface_epoch, config.width, config.height, camera.dpr));
                }
                crate::perf_log(&format!("GPU_SCENE_PRESENT revision={} zoom={:.4} request_to_present_us={} resident_us={}",job.revision,camera.zoom,job.at.elapsed().as_micros(),now.elapsed().as_micros()));
            }
            if let Some(work)=pending.take(){let _=work.done.send(());}
            drop(surface);drop(refiner);
        }).map_err(|e|e.to_string())?;
        Ok(Self {
            latest,
            wake,
            stop,
            thread: Some(thread),
            surface_released,
            #[cfg(test)]
            probe,
        })
    }
    pub fn request(&self, job: FrameRequest) {
        if let Ok(mut q) = self.latest.lock() {
            if crate::perf_enabled(){if let Some(old)=q.as_ref(){
                if old.input.map(|s|s.sequence)!=job.input.map(|s|s.sequence){crate::perf_log(&format!("GPU_REQUEST_COALESCED revision={} input_seq={} replaced_by={} queue_age_us={}",old.revision,old.input.map_or(0,|s|s.sequence),job.input.map_or(0,|s|s.sequence),old.at.elapsed().as_micros()));}
            }}
            *q = Some(job);
        }
        let _ = self.wake.try_send(());
    }
}

#[cfg(test)]
#[path = "presenter_runtime_tests.rs"]
mod runtime_tests;
impl Drop for Presenter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
        if let Some(thread) = self.thread.take() {
            // HWND vẫn đợi đúng fence tài nguyên surface, không đợi CPU join.
            let _=self.surface_released.recv();drop(thread);
        }
    }
}

#[cfg(test)]
mod page_latency_tests {
    use super::*;
    use super::super::{win32_host::Win32ChildViewport,scene_cache};
    use windows::{core::w,Win32::UI::WindowsAndMessaging::{CreateWindowExW,DestroyWindow,SendMessageW,WS_OVERLAPPED,WM_PAINT}};
    #[test]
    fn refinement_batch_adapts_to_completion_without_zero_work(){
        assert_eq!(next_refine_batch_size(8,1_000),16);assert_eq!(next_refine_batch_size(8,8_000),2);
        assert_eq!(next_refine_batch_size(8,0),32);assert_eq!(next_refine_batch_size(1,30_000),1);
    }
    #[test]
    fn surface_release_precedes_cpu_retirement_and_follows_resource_drop(){
        struct Resource(Arc<AtomicBool>);impl Drop for Resource{fn drop(&mut self){self.0.store(true,Ordering::Release);}}
        let released=Arc::new(AtomicBool::new(false));let flag=released.clone();let(tx,rx)=sync_channel(1);let(finish,wait)=sync_channel(1);
        let worker=std::thread::spawn(move||{let surface=ReleaseAfterDrop{value:Some(Resource(flag)),released:Some(tx)};drop(surface);wait.recv().unwrap();});
        rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();assert!(released.load(Ordering::Acquire));
        finish.send(()).unwrap();worker.join().unwrap();
    }
    #[test]
    fn ppe_raster_and_blank_page_do_not_require_primitive_draws(){
        use viewer_gpu::retained_renderer::{FrameContentProof,FrameStats};
        for proof in [FrameContentProof::PpeRaster,FrameContentProof::PpeRetained]{
            let stats=FrameStats{content_proof:proof,..Default::default()};assert_eq!(stats.draws,0);assert!(stats.content_proof.is_verified());
        }
        assert!(!FrameContentProof::OutsidePage.is_verified());assert!(!FrameContentProof::default().is_verified());
    }
    #[test]
    fn camera_refinement_keeps_small_pan_and_one_wheel_step() {
        let base=CameraSnapshot{zoom:1.,pan_x:0.,pan_y:0.,dpr:1.,viewport_width:1280,viewport_height:720};
        let small_pan=CameraSnapshot{pan_x:120.,..base};
        let one_step=CameraSnapshot{zoom:1.15,..base};
        let far_pan=CameraSnapshot{pan_x:600.,..base};
        let large_zoom=CameraSnapshot{zoom:1.7,..base};
        assert!(!camera_change_requires_cancel(base,small_pan));
        assert!(!camera_change_requires_cancel(base,one_step));
        assert!(camera_change_requires_cancel(base,far_pan));
        assert!(camera_change_requires_cancel(base,large_zoom));
    }
    #[test]
    #[ignore="R01 local: PRYNX_R01_PDF và PRYNX_SCENE_TEST_EXE"]
    fn r01_hidden_hwnd_cold_warm_and_cancel_latency() {
        let ctx=Arc::new(GpuContext::new_sync().unwrap());
        let path=std::env::var("PRYNX_R01_PDF").unwrap();
        let mut timings=Vec::new();
        unsafe {
            let parent=CreateWindowExW(Default::default(),w!("STATIC"),w!("R33 kiểm latency ẩn"),WS_OVERLAPPED,0,0,1309,885,None,None,None,None).unwrap();
            for step in 0..3 {
                let view=Win32ChildViewport::create(parent,0,0,1309,885,1.,ctx.clone()).unwrap();
                let (format,revision)={let state=view.state.lock().unwrap();(state.surface_config.format,state.scene_revision.clone())};
                revision.store(1,Ordering::Release);
                let started=std::time::Instant::now();
                let renderer=scene_cache::load(&ctx,format,path.clone(),2,if step==2{"cancel"}else{"warm"}.into(),1,revision).unwrap();
                let load_us=started.elapsed().as_micros();
                assert_eq!(renderer.overview().is_some(),step==1);
                let (tx,rx)=std::sync::mpsc::channel();
                {
                    let mut state=view.state.lock().unwrap();state.install_renderer(1,renderer).unwrap();
                    state.scene_event=Some(Arc::new(move|_,error,_,_|{let _=tx.send(error);}));
                    let mut c=state.controller.lock().unwrap();c.zoom=1.3042;c.pan_x=50.;c.pan_y=40.;
                }
                let started=std::time::Instant::now();
                SendMessageW(view.hwnd,WM_PAINT,None,None);
                let present_us=if step<2 {
                    let error=rx.recv_timeout(std::time::Duration::from_secs(45)).unwrap();assert!(error.is_none(),"{error:?}");
                    started.elapsed().as_micros()
                }else{std::thread::sleep(std::time::Duration::from_millis(100));0};
                let close=std::time::Instant::now();view.destroy().unwrap();let close_us=close.elapsed().as_micros();
                println!("R33 step={step} load_us={load_us} present_us={present_us} close_us={close_us}");
                timings.push((present_us,close_us));
            }
            DestroyWindow(parent).unwrap();
        }
        scene_cache::close_document(&path);
        assert!(timings[1].0<timings[0].0,"Quay lại phải dùng frame đã dựng");
        assert!(timings[2].1<2_000_000,"Hủy tác vụ cũ không được chờ render hết trang");
    }
}
