//! Encode refinement ngoài luồng present; pool được giữ tới ACK submit/hủy.
use super::{controller::CameraSnapshot, presenter::FrameRequest};
use super::detail_cache::RasterCoverage;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
        Arc,
    },
};
use viewer_gpu::{resident_present::ResidentFrame, retained_renderer::FrameStats, GpuContext};
pub struct RefineRequest {
    pub frame: FrameRequest,
    pub overview: bool,
    /// Thế hệ camera; refinement cũ bị hủy ngay khi camera mới đến.
    pub generation: u64,
    pub region: Option<[u32;4]>,
}
pub struct Refined {
    pub frame: ResidentFrame,
    pub commands: VecDeque<wgpu::CommandBuffer>,
    pub camera: CameraSnapshot,
    pub revision: u64,
    pub generation: u64,
    pub overview: bool,
    pub partial: bool,
    pub coverage: RasterCoverage,
    pub at: std::time::Instant,
    pub stats: FrameStats,
    pub done: SyncSender<()>,
}
pub struct Refiner {
    pub send: Sender<RefineRequest>,
    pub receive: Receiver<Result<Refined, (u64, String)>>,
    stop: Arc<AtomicBool>,
    latest_generation: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Refiner {
    pub fn new(
        ctx: Arc<GpuContext>,
        format: wgpu::TextureFormat,
        stop: Arc<AtomicBool>,
        wake: SyncSender<()>,
        revision: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        let (send, jobs) = mpsc::channel::<RefineRequest>();
        let (ready, receive) = mpsc::channel();
        let stop_owner = stop.clone();
        let latest_generation = Arc::new(AtomicU64::new(0));
        let worker_generation = latest_generation.clone();
        let thread = std::thread::Builder::new()
            .name("ppe-refinement-encode".into())
            .spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let job = match jobs.recv_timeout(std::time::Duration::from_millis(50)) {
                        Ok(job) => job,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };
                    let generation = job.generation;
                    crate::perf_log(&format!(
                        "GPU_REFINER_JOB_START rev={} gen={} overview={} region={:?}",
                        job.frame.revision, generation, job.overview, job.region
                    ));
                    let Some(renderer) = &job.frame.renderer else {
                        crate::perf_log(&format!("GPU_REFINER_NO_RENDERER rev={}", job.frame.revision));
                        continue;
                    };
                    let camera = job.frame.camera;
                    let (width, height, matrix) = if job.overview {
                        let b = renderer.scene.bounds;
                        let rotated = renderer.scene.rotation.rem_euclid(180) != 0;
                        let (w, h) = if rotated {
                            (b.height(), b.width())
                        } else {
                            (b.width(), b.height())
                        };
                        let scale = (camera.viewport_width as f32 / w)
                            .min(camera.viewport_height as f32 / h);
                        // PERF (audit 2026-09-25 §G4): overview chỉ là lớp nền
                        // nhưng không được mờ ngay ở fit/zoom nhỏ. Dựng dư 1.5×
                        // trên máy mạnh để khi compositor thu xuống viewport chữ
                        // vẫn sắc; máy yếu giữ hệ số thấp để không tăng peak RAM.
                        let quality = crate::system_memory_status().map_or(1.25, |s| {
                            if s.total_bytes < 8 * 1024 * 1024 * 1024 {
                                1.0
                            } else if s.total_bytes < 16 * 1024 * 1024 * 1024 {
                                1.25
                            } else {
                                1.5
                            }
                        });
                        (
                            (w * scale * quality).ceil().max(1.) as u32,
                            (h * scale * quality).ceil().max(1.) as u32,
                            renderer
                                .scene
                                .page_to_view(scale * quality / renderer.scene.user_unit, 0., 0.),
                        )
                    } else {
                        (
                            camera.viewport_width,
                            camera.viewport_height,
                            renderer.scene.page_to_view(
                                camera.zoom * camera.dpr,
                                camera.pan_x * camera.dpr,
                                camera.pan_y * camera.dpr,
                            ),
                        )
                    };
                    let matrix = renderer.raster_matrix(matrix);
                    let texture = ctx.create_target_texture(
                        width,
                        height,
                        format,
                        Some("PPE refinement resident"),
                    );
                    let result =
                        renderer.with_prepared_region_cancellable(&ctx, &texture, width, height, matrix,if job.overview{None}else{job.region},
                            &||stop.load(Ordering::Acquire)
                                || revision.load(Ordering::Acquire)!=job.frame.revision
                                || worker_generation.load(Ordering::Acquire)!=generation, |mut prepared| {
                            let crop=job.region.filter(|_|!job.overview && prepared.stats.content_proof==viewer_gpu::retained_renderer::FrameContentProof::PpeRetained);
                            let (resident,resident_matrix)=if let Some([x,y,w,h])=crop {
                                let cropped=ctx.create_target_texture(w,h,format,Some("PPE vùng mới lộ"));
                                let mut copy=ctx.device.create_command_encoder(&Default::default());
                                copy.copy_texture_to_texture(wgpu::TexelCopyTextureInfo{texture:&texture,mip_level:0,origin:wgpu::Origin3d{x,y,z:0},aspect:wgpu::TextureAspect::All},wgpu::TexelCopyTextureInfo{texture:&cropped,mip_level:0,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},wgpu::Extent3d{width:w,height:h,depth_or_array_layers:1});
                                prepared.commands.push(copy.finish());
                                (cropped,print_engine::geom::Matrix{e:matrix.e-x as f32,f:matrix.f-y as f32,..matrix})
                            }else{(texture.clone(),renderer.raster_matrix(matrix))};
                            let (done, ack) = mpsc::sync_channel(1);
                            let value = Refined {
                                frame: ResidentFrame {
                                    texture: resident,
                                    // Material tạo muộn có thể chốt fallback PPE;
                                    // lưu ma trận raster thật sau khi backend đã chọn.
                                    matrix: resident_matrix,
                                },
                                commands: prepared.commands.into(),
                                camera,
                                revision: job.frame.revision,
                                generation,
                                overview: job.overview,
                                partial: crop.is_some(),
                                // PERF (audit 2026-09-27 §V27.R1): coverage lấy
                                // từ đúng crop đã copy, không từ matrix texture
                                // bị làm tròn sau phép trừ origin.
                                coverage: crop.map_or_else(||RasterCoverage::full(resident_matrix,width,height),|rect|RasterCoverage{matrix,rect}),
                                at: job.frame.at,
                                stats: prepared.stats,
                                done,
                            };
                            crate::perf_log(&format!(
                                "GPU_REFINER_ENCODE_DONE rev={} gen={} partial={} proof={:?}",
                                job.frame.revision, generation, crop.is_some(), value.stats.content_proof
                            ));
                            if ready.send(Ok(value)).is_err() {
                                crate::perf_log(&format!("GPU_REFINER_SEND_ERR presenter disconnected rev={} gen={}", job.frame.revision, generation));
                                return;
                            }
                            let _ = wake.try_send(());
                            while !stop.load(Ordering::Acquire) {
                                match ack.recv_timeout(std::time::Duration::from_millis(50)) {
                                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                                    _ => {
                                        crate::perf_log(&format!("GPU_REFINER_ACK_DONE rev={} gen={}", job.frame.revision, generation));
                                        break;
                                    }
                                }
                            }
                        });
                    if let Err(e) = result {
                        crate::perf_log(&format!("GPU_REFINER_JOB_ERROR_OR_CANCEL rev={} gen={} err={:?}", job.frame.revision, generation, e));
                        let _ = ready.send(Err((job.frame.revision, e.to_string())));
                        let _ = wake.try_send(());
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            send,
            receive,
            stop: stop_owner,
            latest_generation,
            thread: Some(thread),
        })
    }

    /// Hủy lượt đang encode khi camera đã đổi, không chờ render stale xong.
    pub fn invalidate(&self) {
        let prev = self.latest_generation.fetch_add(1, Ordering::AcqRel);
        crate::perf_log(&format!("GPU_REFINER_INVALIDATE gen {} -> {}", prev, prev + 1));
    }

    /// Gửi duy nhất lượt camera mới nhất và gắn thế hệ để worker tự hủy lượt cũ.
    pub fn submit(&self, mut request: RefineRequest) -> bool {
        let generation = self.latest_generation.fetch_add(1, Ordering::AcqRel) + 1;
        request.generation = generation;
        crate::perf_log(&format!(
            "GPU_REFINER_SUBMIT rev={} gen={} overview={} region={:?}",
            request.frame.revision, generation, request.overview, request.region
        ));
        self.send.send(request).is_ok()
    }

    pub fn current_generation(&self) -> u64 {
        self.latest_generation.load(Ordering::Acquire)
    }
}
impl Drop for Refiner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
#[path = "refinement_liveness_tests.rs"]
mod liveness_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use print_engine::{
        color::{icc::ColorManager, RenderIntent},
        scene::retained::RetainedPage,
    };
    use viewer_gpu::{
        resident_present::{ResidentCompositor, ResidentFrame},
        retained_renderer::RetainedRenderer,
    };
    #[test]
    fn partial_refinement_keeps_global_matrix_and_copies_only_missing_pixels(){
        use lopdf::{dictionary,Document,Stream};
        use print_engine::content::RenderOptions;
        use super::super::document_renderer::DocumentRenderer;
        use std::time::Instant;
        let mut doc=Document::with_version("1.7");let pages=doc.new_object_id();
        let contents=doc.add_object(Stream::new(dictionary!{},b"1 0 0 0 k 0 0 32 24 re f 0 1 0 0 k 5 5 15 10 re f".to_vec()));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),32.into(),24.into()],"Contents"=>contents,"Resources"=>dictionary!{}});
        doc.objects.insert(pages,dictionary!{"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into());let catalog=doc.add_object(dictionary!{"Type"=>"Catalog","Pages"=>pages});doc.trailer.set("Root",catalog);
        let ctx=Arc::new(GpuContext::new_sync().unwrap());let cm=super::super::scene_worker::color_manager().unwrap();
        let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(&cm)).unwrap());
        let renderer=Arc::new(RetainedRenderer::new(&ctx,scene.clone(),&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap());
        let camera=CameraSnapshot{zoom:1.,pan_x:-3.25,pan_y:0.5,dpr:1.,viewport_width:32,viewport_height:24};let matrix=scene.page_to_view(camera.zoom,camera.pan_x,camera.pan_y);
        let full=ctx.create_target_texture(32,24,wgpu::TextureFormat::Rgba8Unorm,None);renderer.render(&ctx,&full.create_view(&Default::default()),32,24,matrix).unwrap();
        let expected=ctx.readback_texture_rgba8(&full,32,24).unwrap();
        let(wake,_)=mpsc::sync_channel(1);let worker=Refiner::new(ctx.clone(),wgpu::TextureFormat::Rgba8Unorm,Arc::new(AtomicBool::new(false)),wake,Arc::new(AtomicU64::new(1))).unwrap();
        assert!(worker.submit(RefineRequest{frame:FrameRequest{camera,renderer:Some(Arc::new(DocumentRenderer::gpu(renderer))),revision:1,at:Instant::now(),notify:None,input:None,overlays:vec![]},overview:false,generation:0,region:Some([7,3,13,9])}));
        let work=worker.receive.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
        assert!(work.partial);assert_eq!((work.frame.texture.width(),work.frame.texture.height()),(13,9));
        assert_eq!(work.coverage,RasterCoverage{matrix,rect:[7,3,13,9]});
        assert_eq!(work.frame.matrix,print_engine::geom::Matrix{e:matrix.e-7.,f:matrix.f-3.,..matrix});
        ctx.queue.submit(work.commands);work.done.send(()).unwrap();let actual=ctx.readback_texture_rgba8(&work.frame.texture,13,9).unwrap();
        for row in 0..9{assert_eq!(&actual[row*13*4..(row+1)*13*4],&expected[((row+3)*32+7)*4..((row+3)*32+20)*4]);}
    }
    #[test]
    #[ignore = "R01 local: PRYNX_R01_WORKER_PACKET, PRYNX_R01_OUT"]
    fn r01_camera_keeps_presenting_while_native_worker_refines() {
        let ctx = Arc::new(GpuContext::new_sync().unwrap());
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let scene = Arc::new(
            RetainedPage::read_wire(
                std::fs::File::open(std::env::var("PRYNX_R01_WORKER_PACKET").unwrap()).unwrap(),
                17,
                8 * 1024 * 1024 * 1024,
            )
            .unwrap(),
        );
        let cm = ColorManager::from_cmyk_profile(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../backend/app/assets/icc/FOGRA39.icc"),
            RenderIntent::RelativeColorimetric,
        )
        .unwrap();
        let renderer = Arc::new(RetainedRenderer::new(&ctx, scene, &cm, format).unwrap());
        let width = 1081;
        let height = 811;
        let fit = 104. / 72.;
        let base_matrix = renderer.scene.page_to_view(fit, 0., 0.);
        let texture = ctx.create_target_texture(width, height, format, None);
        renderer
            .render(
                &ctx,
                &texture.create_view(&Default::default()),
                width,
                height,
                base_matrix,
            )
            .unwrap();
        ctx.device.poll(wgpu::Maintain::Wait);
        let renderer = Arc::new(super::super::document_renderer::DocumentRenderer::gpu(
            renderer,
        ));
        let base = ResidentFrame {
            texture,
            matrix: base_matrix,
        };
        let mut detail = None;
        let (wake, _rx) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let worker = Refiner::new(ctx.clone(), format, stop, wake, Arc::new(AtomicU64::new(17))).unwrap();
        let compositor = ResidentCompositor::new(&ctx, format);
        let output = ctx.create_target_texture(width, height, format, None);
        let mut pending: Option<Refined> = None;
        let mut busy = false;
        let mut ready_count = 0;
        let started = std::time::Instant::now();
        let mut next_tick = started;
        let mut ticks = 0;
        let mut trace = String::from("tick,input_ready_us,resident_us,refinements\n");
        let mut submitted = CameraSnapshot {
            zoom: fit,
            pan_x: 0.,
            pan_y: 0.,
            dpr: 1.,
            viewport_width: width,
            viewport_height: height,
        };
        let mut completed = None;
        while ticks < 120 || busy || completed != Some(submitted) {
            if let Ok(work) = worker.receive.try_recv() {
                pending = Some(work.unwrap());
            }
            if let Some(work) = pending.as_mut() {
                let now = std::time::Instant::now();
                while !work.commands.is_empty() {
                    let batch: Vec<_> = work.commands.drain(..work.commands.len().min(4)).collect();
                    ctx.queue.submit(batch);
                    ctx.device.poll(wgpu::Maintain::Wait);
                    if now.elapsed() >= std::time::Duration::from_millis(4) {
                        break;
                    }
                }
                if work.commands.is_empty() {
                    let work = pending.take().unwrap();
                    detail = Some(work.frame);
                    completed = Some(work.camera);
                    let _ = work.done.send(());
                    busy = false;
                    ready_count += 1;
                }
            }
            if ticks < 120 && std::time::Instant::now() >= next_tick {
                let input = next_tick;
                next_tick += std::time::Duration::from_micros(16_667);
                let phase = if ticks < 60 {
                    ticks as f32 / 59.
                } else {
                    (119 - ticks) as f32 / 59.
                };
                let scale = fit * 4f32.powf(phase);
                submitted.zoom = scale;
                submitted.pan_x =
                    -((renderer.scene.bounds.width() * scale - width as f32) * 0.5).max(0.);
                submitted.pan_y =
                    -((renderer.scene.bounds.height() * scale - height as f32) * 0.5).max(0.);
                let matrix = renderer
                    .scene
                    .page_to_view(scale, submitted.pan_x, submitted.pan_y);
                let now = std::time::Instant::now();
                let mut e = ctx.device.create_command_encoder(&Default::default());
                compositor
                    .encode(
                        &ctx,
                        &mut e,
                        &output.create_view(&Default::default()),
                        matrix,
                        &base,
                        detail.as_ref(),
                    )
                    .unwrap();
                ctx.queue.submit([e.finish()]);
                ctx.device.poll(wgpu::Maintain::Wait);
                trace.push_str(&format!(
                    "{ticks},{},{},{ready_count}\n",
                    input.elapsed().as_micros(),
                    now.elapsed().as_micros()
                ));
                ticks += 1;
            }
            if !busy && completed != Some(submitted) {
                worker
                    .send
                    .send(RefineRequest {
                        frame: FrameRequest {
                            camera: submitted,
                            renderer: Some(renderer.clone()),
                            revision: 17,
                            at: std::time::Instant::now(),
                            notify: None,
                            input: None,
                            overlays: Vec::new(),
                        },
                        overview: false,
                        generation: 0,
                        region: None,
                    })
                    .unwrap();
                busy = true;
            }
            if pending.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(30),
                "refinement không tiến triển"
            );
        }
        assert!(
            ready_count >= 5,
            "Chỉ {ready_count} refinement trong chuỗi camera"
        );
        let out = std::path::PathBuf::from(std::env::var("PRYNX_R01_OUT").unwrap());
        std::fs::write(out.join("r01-native-resident-trace.csv"), trace).unwrap();
        println!(
            "native refiner: {ticks} camera, {ready_count} refinement, elapsed {:?}",
            started.elapsed()
        );
        // Kiểm camera cuối thực sự hoàn tất, không chỉ đổi camera của bitmap cũ.
        assert_eq!(completed, Some(submitted));
        let detail = detail.unwrap();
        let got = ctx
            .readback_texture_rgba8(&detail.texture, width, height)
            .unwrap();
        let expected = ctx
            .readback_texture_rgba8(&base.texture, width, height)
            .unwrap();
        assert_eq!(got, expected);
    }
}
