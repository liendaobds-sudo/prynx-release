//! PERF (audit 2026-09-25 §R25.GPU.26): chọn engine một lần cho vòng đời trang.
//! Closure chưa chạy GPU (RGB/non-separable) dùng PPE worker hiện hữu, cùng
//! resident compositor. Không đổi PDFium/PPE theo từng cử chỉ.
use crate::pdf_engine::render_worker::{
    self, AccurateWorkerAttempt, RenderPurpose, ViewerRenderContext,
};
use print_engine::{color::icc::ColorManager, geom::Matrix, scene::retained::RetainedPage};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use viewer_gpu::{
    retained_renderer::{FrameStats, PreparedFrame, RetainedRenderer, RendererResources},
    GpuContext,
};
use wgpu::util::DeviceExt;
static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

// PERF (audit 2026-09-27 §V27.F): watcher mượn cả generation camera,
// không chỉ revision tài liệu. Hủy vật lý không đóng session dùng chung.
fn with_cancel_watcher<T>(cancel:&(dyn Fn()->bool+Sync),work:impl FnOnce()->T,on_cancel:impl Fn()+Sync)->T {
    let (done,stop)=std::sync::mpsc::channel::<()>();
    std::thread::scope(|scope|{
        let callback=&on_cancel;
        let watcher=scope.spawn(move||while matches!(stop.recv_timeout(std::time::Duration::from_millis(20)),Err(std::sync::mpsc::RecvTimeoutError::Timeout)){
            if cancel(){callback();}
        });
        let result=work();drop(done);let _=watcher.join();result
    })
}

#[cfg(test)]
mod cancellation_watcher_tests {
    #[test]
    fn camera_cancel_is_delivered_while_worker_is_still_running(){
        let cancelled=std::sync::atomic::AtomicBool::new(false);let(tx,rx)=std::sync::mpsc::channel();
        super::with_cancel_watcher(&||cancelled.load(std::sync::atomic::Ordering::Acquire),||{
            cancelled.store(true,std::sync::atomic::Ordering::Release);
            rx.recv_timeout(std::time::Duration::from_secs(1)).expect("Phải hủy trước khi worker hoàn tất");
        },||{let _=tx.send(());});
    }
}

pub struct CpuSource {
    pub path: String,
    pub page: usize,
    pub revision: u64,
    pub current: Arc<AtomicU64>,
}
struct CpuPage {
    source: CpuSource,
    owner: String,
    sequence: AtomicU64,
    format: wgpu::TextureFormat,
}
// PERF (audit 2026-09-25 §R25.GPU.31): cache không giữ revision/cancellation của view.
type OverviewCache=Arc<Mutex<Option<Arc<viewer_gpu::resident_present::ResidentFrame>>>>;
pub struct PreparedScene {pub scene:Arc<RetainedPage>,gpu:Option<Arc<RetainedRenderer>>,overview:OverviewCache}
impl PreparedScene {
    pub fn new(ctx:&GpuContext,scene:Arc<RetainedPage>,resources:Arc<RendererResources>)->Result<Self,String>{
        let gpu=match RetainedRenderer::with_resources(ctx,scene.clone(),resources){
            Ok(value)=>Some(Arc::new(value)),
            Err(error)=>{crate::perf_log(&format!("GPU_SCENE_ENGINE engine=ppe-worker reason={error}"));None}
        };
        Ok(Self{scene,gpu,overview:Default::default()})
    }
}
pub struct DocumentRenderer {
    pub scene:Arc<RetainedPage>,gpu:Option<Arc<RetainedRenderer>>,cpu:Option<CpuPage>,gpu_disabled:AtomicBool,overview:OverviewCache,
}
impl DocumentRenderer {
    pub fn gpu(renderer:Arc<RetainedRenderer>)->Self{
        Self{scene:renderer.scene.clone(),gpu:Some(renderer),cpu:None,gpu_disabled:AtomicBool::new(false),overview:Default::default()}
    }
    pub fn bind(prepared:&PreparedScene,format:wgpu::TextureFormat,source:CpuSource)->Result<Self,String>{
        let gpu=prepared.gpu.as_ref().map(|g|g.fork_for_view().map(Arc::new).map_err(|e|e.to_string())).transpose()?;
        Ok(Self{scene:prepared.scene.clone(),gpu,overview:prepared.overview.clone(),gpu_disabled:AtomicBool::new(false),cpu:Some(CpuPage {
            source,owner:format!("native-scene:{}:{}",std::process::id(),NEXT_OWNER.fetch_add(1,Ordering::Relaxed)),
            sequence:AtomicU64::new(0),format,
        })})
    }
    pub fn new(ctx:&GpuContext,scene:Arc<RetainedPage>,color:&ColorManager,format:wgpu::TextureFormat,source:CpuSource)->Result<Self,String>{
        let resources=Arc::new(RendererResources::new(ctx,color,format).map_err(|e|e.to_string())?);
        Self::bind(&PreparedScene::new(ctx,scene,resources)?,format,source)
    }
    // PERF (audit 2026-09-25 §R25.GPU.33): giữ khung toàn trang đã submit
    // cùng scene/profile/device; quay lại trang không dựng overview từ đầu.
    pub fn overview(&self)->Option<Arc<viewer_gpu::resident_present::ResidentFrame>> {
        self.overview.lock().ok().and_then(|v|v.clone())
    }
    pub fn remember_overview(&self,frame:Arc<viewer_gpu::resident_present::ResidentFrame>) {
        if let Ok(mut value)=self.overview.lock(){*value=Some(frame);}
    }
    pub fn clear_gpu_frame_resources(&self) {
        if let Some(gpu) = &self.gpu { gpu.clear_frame_resources(); }
    }
    /// PPE region dùng tọa độ pixel nguyên; compositor bù phần lẻ bằng ma trận,
    /// tránh gắn ảnh đã làm tròn vào camera chưa làm tròn gây nhảy vị trí.
    pub fn raster_matrix(&self, matrix: Matrix) -> Matrix {
        if self.gpu.is_some() && !self.gpu_disabled.load(Ordering::Acquire) {
            return matrix;
        }
        let scale = matrix.a.hypot(matrix.b);
        let base =
            print_engine::page::device_matrix(&self.scene.bounds, scale * 72., self.scene.rotation);
        Matrix::new(
            matrix.a,
            matrix.b,
            matrix.c,
            matrix.d,
            base.e + (matrix.e - base.e).round(),
            base.f + (matrix.f - base.f).round(),
        )
    }
    pub fn with_prepared<T>(
        &self,
        ctx: &GpuContext,
        output: &wgpu::Texture,
        width: u32,
        height: u32,
        matrix: Matrix,
        consume: impl FnOnce(PreparedFrame) -> T,
    ) -> Result<T, String> {
        self.with_prepared_cancellable(ctx,output,width,height,matrix,&||false,consume)
    }
    pub fn with_prepared_cancellable<T>(&self,ctx:&GpuContext,output:&wgpu::Texture,width:u32,height:u32,matrix:Matrix,
        cancel:&(dyn Fn()->bool+Sync),consume:impl FnOnce(PreparedFrame)->T)->Result<T,String> {
        self.with_prepared_region_cancellable(ctx,output,width,height,matrix,None,cancel,consume)
    }
    pub fn supports_partial_refinement(&self)->bool{self.gpu.is_some() && !self.gpu_disabled.load(Ordering::Acquire)}
    pub fn with_prepared_region_cancellable<T>(&self,ctx:&GpuContext,output:&wgpu::Texture,width:u32,height:u32,matrix:Matrix,region:Option<[u32;4]>,
        cancel:&(dyn Fn()->bool+Sync),consume:impl FnOnce(PreparedFrame)->T)->Result<T,String> {
        if cancel(){return Err("Frame đã bị thay thế".into());}
        let mut consume=Some(consume);
        if let Some(gpu)=self.gpu.as_ref().filter(|_|!self.gpu_disabled.load(Ordering::Acquire)) {
            match gpu.with_prepared_region_cancellable(ctx,&output.create_view(&Default::default()),width,height,matrix,region,cancel,|p|consume.take().unwrap()(p)) {
                Ok(value)=>return Ok(value),
                Err(error)=>{
                    if cancel(){return Err("Frame đã bị thay thế".into());}
                    if self.cpu.is_none(){return Err(error.to_string());}
                    // Resource tạo muộn không hợp lệ: chưa submit frame dở dang.
                    // Chốt cả trang sang PPE cho phần còn lại của lease, không đổi theo wheel.
                    self.gpu_disabled.store(true,Ordering::Release);
                    crate::perf_log(&format!("GPU_SCENE_ENGINE engine=ppe-worker phase=material reason={error}"));
                }
            }
        }
        let cpu = self.cpu.as_ref().ok_or("Thiếu engine trang")?;
        let started = std::time::Instant::now();
        if cpu.source.current.load(Ordering::Acquire) != cpu.source.revision {
            return Err("Trang PPE đã bị thay thế".into());
        }
        let scale = matrix.a.hypot(matrix.b);
        let base =
            print_engine::page::device_matrix(&self.scene.bounds, scale * 72., self.scene.rotation);
        let pan_x = (matrix.e - base.e).round() as i64;
        let pan_y = (matrix.f - base.f).round() as i64;
        let (page_width, page_height) =
            print_engine::page::raster_size(&self.scene.bounds, scale * 72., self.scene.rotation)
                .map_err(|e| e.to_string())?;
        let (page_width, page_height) = (i64::from(page_width), i64::from(page_height));
        let x0 = 0i64.max(-pan_x);
        let y0 = 0i64.max(-pan_y);
        let x1 = page_width.min(width as i64 - pan_x);
        let y1 = page_height.min(height as i64 - pan_y);
        let mut rgba = [82u8, 86, 89, 255].repeat(width as usize * height as usize);
        if x1 > x0 && y1 > y0 {
            if [x0, y0, x1, y1].iter().any(|v| *v > i32::MAX as i64) {
                return Err("Vùng PPE vượt tọa độ raster".into());
            }
            let serial = cpu.sequence.fetch_add(1, Ordering::Relaxed);
            let request_id = format!("{}:{serial}", cpu.owner);
            let context = ViewerRenderContext {
                request_id: request_id.clone(),
                owner_id: cpu.owner.clone(),
                group_key: cpu.owner.clone(),
                generation: cpu.source.revision,
                purpose: RenderPurpose::Interactive,
                priority: 100,
                pipeline_identity: render_worker::RENDER_WORKER_ACCURATE_PIPELINE_ID.into(),
            };
            let result = with_cancel_watcher(&||cancel() || cpu.source.current.load(Ordering::Acquire)!=cpu.source.revision,||render_worker::render_accurate_with_policy(
                &cpu.source.path,
                cpu.source.page as i32,
                scale * 72.,
                0,
                Some(x0 as i32),
                Some(y0 as i32),
                Some((x1 - x0) as i32),
                Some((y1 - y0) as i32),
                &cpu.owner,
                Some(&context),
            ),||{render_worker::cancel_render_request(&request_id);});
            if cancel(){return Err("Frame đã bị thay thế".into());}
            if cpu.source.current.load(Ordering::Acquire) != cpu.source.revision {
                return Err("Trang PPE đã bị thay thế".into());
            }
            let output = match result? {
                AccurateWorkerAttempt::Completed(value) => value,
                AccurateWorkerAttempt::Unsupported(value) => {
                    return Err(format!("PPE chưa bảo đảm kết quả: {}", value.detail))
                }
                AccurateWorkerAttempt::FallbackBeforeStart(reason) => return Err(reason),
                AccurateWorkerAttempt::Disabled => return Err("PPE worker đang tắt".into()),
            };
            let image = image::load_from_memory(&output.bytes)
                .map_err(|e| format!("Ảnh PPE lỗi: {e}"))?
                .to_rgba8();
            if image.width() != (x1 - x0) as u32 || image.height() != (y1 - y0) as u32 {
                return Err("PPE trả kích thước không khớp camera".into());
            }
            for y in 0..image.height() as usize {
                // Tính offset bằng số có dấu trước khi chuyển usize (pan âm).
                let target =
                    ((y as i64 + y0 + pan_y) as usize * width as usize + (x0 + pan_x) as usize) * 4;
                let row = &image.as_raw()
                    [y * image.width() as usize * 4..(y + 1) * image.width() as usize * 4];
                rgba[target..target + row.len()].copy_from_slice(row);
            }
        }
        if matches!(
            cpu.format,
            wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb
        ) {
            for p in rgba.chunks_exact_mut(4) {
                p.swap(0, 2);
            }
        }
        let stride = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let mut padded = vec![0; stride as usize * height as usize];
        for y in 0..height as usize {
            padded[y * stride as usize..y * stride as usize + width as usize * 4]
                .copy_from_slice(&rgba[y * width as usize * 4..(y + 1) * width as usize * 4]);
        }
        let upload = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("PPE page fallback upload"),
                contents: &padded,
                usage: wgpu::BufferUsages::COPY_SRC,
            });
        let mut e = ctx.device.create_command_encoder(&Default::default());
        e.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer: &upload,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            wgpu::TexelCopyTextureInfo {
                texture: output,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        Ok(consume.take().unwrap()(PreparedFrame {
            commands: vec![e.finish()],
            stats: FrameStats {
                encode_us: started.elapsed().as_micros(),
                content_proof: if x1>x0 && y1>y0 {viewer_gpu::retained_renderer::FrameContentProof::PpeRaster}
                    else {viewer_gpu::retained_renderer::FrameContentProof::OutsidePage},
                ..Default::default()
            },
        }))
    }
}
impl Drop for CpuPage {
    fn drop(&mut self) {
        if self.sequence.load(Ordering::Relaxed)==0{return;}
        let owner = self.owner.clone();
        let _ = std::thread::Builder::new()
            .name("ppe-scene-release".into())
            .spawn(move || {
                let _ = render_worker::release_accurate_session_owner_with_policy(&owner);
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Stream};
    use print_engine::{
        content::RenderOptions,
        page::{render_page_managed, PageBox},
    };
    #[test]
    #[ignore = "worker thật: PRYNX_RENDER_WORKER_TEST_EXE và PRYNX_R01_OUT"]
    fn rgb_group_worker_upload_preserves_pan_crop_rotation_and_fractional_scale() {
        let ctx = GpuContext::new_sync().unwrap();
        let cm = super::super::scene_worker::color_manager().unwrap();
        let out = std::path::PathBuf::from(std::env::var("PRYNX_R01_OUT").unwrap());
        for (rotation, late_failure) in [(0, false), (90, false), (0, true)] {
            let mut doc = Document::with_version("1.7");
            let pages = doc.new_object_id();
            let content = doc.add_object(Stream::new(
                Default::default(),
                b"0.8 0.2 0.1 rg 10 20 100 80 re f 0.1 0.3 0.8 rg 15 30 20 35 re f".to_vec(),
            ));
            let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),120.into(),120.into()],
                "CropBox"=>vec![10.into(),20.into(),110.into(),100.into()],"Rotate"=>rotation,"UserUnit"=>2,
                "Group"=>dictionary!{"S"=>"Transparency","CS"=>"DeviceRGB","I"=>true},"Contents"=>content,"Resources"=>dictionary!{}});
            doc.objects.insert(
                pages,
                dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into(),
            );
            let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
            doc.trailer.set("Root", catalog);
            if late_failure {
                // Ảnh hợp lệ với PPE nhưng rộng hơn texture GPU: lỗi chỉ lộ khi
                // dựng material muộn. Frame dở dang không được present rồi đổi engine.
                let width=ctx.device.limits().max_texture_dimension_2d+1;
                let image=doc.add_object(Stream::new(dictionary!{"Subtype"=>"Image","Width"=>width as i64,"Height"=>1,"BitsPerComponent"=>8,"ColorSpace"=>"DeviceCMYK"},[255,0,0,0].repeat(width as usize)));
                doc.objects.insert(content,Stream::new(Default::default(),b"q 100 0 0 80 10 20 cm /I Do Q".to_vec()).into());
                let page=doc.get_object_mut(page).unwrap().as_dict_mut().unwrap();page.remove(b"Group");
                page.set("Resources",dictionary!{"XObject"=>dictionary!{"I"=>image}});
            }
            let path = out.join(format!("native-rgb-fallback-{rotation}-{late_failure}.pdf"));
            doc.save(&path).unwrap();
            let scene = Arc::new(
                RetainedPage::compile(&doc, 1, RenderOptions::viewer(), Some(&cm)).unwrap(),
            );
            let current = Arc::new(AtomicU64::new(1));
            let renderer = DocumentRenderer::new(
                &ctx,
                scene,
                &cm,
                wgpu::TextureFormat::Rgba8Unorm,
                CpuSource {
                    path: path.to_string_lossy().into_owned(),
                    page: 1,
                    revision: 1,
                    current: current.clone(),
                },
            )
            .unwrap();
            assert_eq!(renderer.gpu.is_some(),late_failure);
            for (scale, x, y) in [
                (1.013, -17.3, -11.7),
                (0.517, 14.8, 7.2),
                (2.137, -90.4, -71.1),
            ] {
                let matrix = renderer.raster_matrix(renderer.scene.page_to_view(scale / 2., x, y));
                let target =
                    ctx.create_target_texture(96, 73, wgpu::TextureFormat::Rgba8Unorm, None);
                renderer
                    .with_prepared(&ctx, &target, 96, 73, matrix, |p| {
                        if late_failure {assert!(renderer.gpu_disabled.load(Ordering::Acquire));}
                        let actual=renderer.raster_matrix(matrix);
                        let base=print_engine::page::device_matrix(&renderer.scene.bounds,actual.a.hypot(actual.b)*72.,rotation);
                        assert!(((actual.e-base.e)-(actual.e-base.e).round()).abs()<0.0001);
                        assert!(((actual.f-base.f)-(actual.f-base.f).round()).abs()<0.0001);
                        ctx.queue.submit(p.commands);
                    })
                    .unwrap();
                let got = ctx.readback_texture_rgba8(&target, 96, 73).unwrap();
                let actual_scale = matrix.a.hypot(matrix.b);
                let cpu = render_page_managed(
                    &doc,
                    1,
                    actual_scale * 72.,
                    PageBox::Crop,
                    RenderOptions::viewer(),
                    Some(&cm),
                )
                .unwrap();
                let rgb = cpu.buffer.to_srgb(&cm).unwrap();
                let width = cpu.buffer.width() as i64;
                let height = cpu.buffer.height() as i64;
                let base = print_engine::page::device_matrix(
                    &renderer.scene.bounds,
                    actual_scale * 72.,
                    rotation,
                );
                let px = (matrix.e - base.e).round() as i64;
                let py = (matrix.f - base.f).round() as i64;
                for dy in 0..73i64 {
                    for dx in 0..96i64 {
                        let (sx, sy) = (dx - px, dy - py);
                        let expected = if sx >= 0 && sx < width && sy >= 0 && sy < height {
                            let at = (sy * width + sx) as usize * 3;
                            [rgb[at], rgb[at + 1], rgb[at + 2], 255]
                        } else {
                            [82, 86, 89, 255]
                        };
                        let at = (dy * 96 + dx) as usize * 4;
                        for c in 0..4 {
                            assert!(got[at+c].abs_diff(expected[c])<=1,"rotation={rotation} scale={scale} at={dx},{dy}: {:?} != {expected:?}",&got[at..at+4]);
                        }
                    }
                }
            }
            current.store(2, Ordering::Release);
            let target = ctx.create_target_texture(96, 73, wgpu::TextureFormat::Rgba8Unorm, None);
            assert!(renderer
                .with_prepared(
                    &ctx,
                    &target,
                    96,
                    73,
                    renderer.scene.page_to_view(1., 0., 0.),
                    |_| ()
                )
                .is_err());
        }
    }
}
