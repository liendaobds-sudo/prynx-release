//! PDF → retained scene → GPU mực/mask/group → ICC → target, không readback.
use std::{collections::{HashMap,HashSet},sync::{Arc,Mutex}};
use crate::{GpuContext,GpuError,ink_surface::{InkSurface,InkSurfacePool,InkCompositor,InkDispatch},
    icc_resolve::{IccProofLut,IccResolve,IccResolveResources},retained_material::{Material,MaterialSampler}};
use print_engine::{scene::retained::*,color::icc::ColorManager,geom::Matrix,
    ink::InkSpace,image::sampler::ImageSampler,content::BlendSpace,blend::BlendMode};
use tiny_skia::{Mask,Transform};
use std::hash::{Hash,Hasher};
use wgpu::util::DeviceExt;

// PERF (audit 2026-09-25 §R25.GPU.31): tách chuẩn bị khỏi thời gian vẽ frame đầu.
#[derive(Debug, Default, Clone)]
pub struct PrepareStats {
    pub validate_us: u128, pub materials_us: u128, pub lut_us: u128,
    pub pipelines_us: u128, pub total_us: u128,
}
pub struct RetainedRenderer {
    pub preparation: PrepareStats,
    pub scene:Arc<RetainedPage>,
    pub space:InkSpace,
    materials:Arc<Mutex<HashMap<usize,Arc<Material>>>>,
    resources:Arc<RendererResources>,
    resolve:Arc<IccResolve>,
    surfaces:Mutex<InkSurfacePool>,
    bounds:Arc<HashMap<usize,print_engine::geom::Rect>>,
    fallback_color:Mutex<ColorManager>,
    clip_cache:Mutex<ClipRasterCache>,
}
/// Profile/intent được giữ cùng tài nguyên; caller không thể ghép LUT cũ với CM mới.
pub struct RendererResources {
    gpu_id:u64,
    compositor:InkCompositor,sampler:MaterialSampler,resolve:Arc<IccResolveResources>,
    color:Mutex<ColorManager>,pub preparation:PrepareStats,
}
impl RendererResources {
    pub fn new(ctx:&GpuContext,cm:&ColorManager,format:wgpu::TextureFormat)->Result<Self,GpuError>{
        let started=std::time::Instant::now();let lut=IccProofLut::build(cm,33,Default::default())?;
        let lut_us=started.elapsed().as_micros();let phase=std::time::Instant::now();
        let resolve=Arc::new(IccResolveResources::new(ctx,format,&lut));
        let compositor=InkCompositor::new(ctx);let sampler=MaterialSampler::new(ctx);
        let color=Mutex::new(cm.fork_for_render().map_err(err)?);
        Ok(Self{gpu_id:ctx.identity(),compositor,sampler,resolve,color,preparation:PrepareStats {
            lut_us,pipelines_us:phase.elapsed().as_micros(),total_us:started.elapsed().as_micros(),..Default::default()
        }})
    }
}
#[derive(Debug,Default,Clone)]
pub struct FrameStats {pub draws:usize,pub groups:usize,pub masks:usize,pub culled:usize,pub coverage_bytes:usize,pub encode_us:u128,pub material_prepare_us:u128,pub material_builds:usize,pub peak_masks:usize,pub clip_us:u128,pub clip_pixels:usize,pub clip_cache_reused:usize,pub content_proof:FrameContentProof}
/// COLOR (audit 2026-09-27 §V27.04/C3): trang trắng hợp lệ vẫn có proof;
/// draws=0 không thể phân biệt nó với ảnh PPE CPU hoặc một frame chưa dựng.
#[derive(Debug,Default,Clone,Copy,PartialEq,Eq)]
pub enum FrameContentProof { #[default] Unverified, OutsidePage, PpeRetained, PpeRaster }
impl FrameContentProof {pub fn is_verified(self)->bool{matches!(self,Self::PpeRetained|Self::PpeRaster)}}
/// PERF (audit 2026-09-25 §R25.GPU.22): lệnh refinement chia ở biên primitive.
/// Presenter có thể xen khung camera giữa các đoạn mà không phá thứ tự backdrop.
pub struct PreparedFrame {pub commands:Vec<wgpu::CommandBuffer>,pub stats:FrameStats}
struct Commands<'a> {ctx:&'a GpuContext,current:wgpu::CommandEncoder,ready:Vec<wgpu::CommandBuffer>}
impl<'a> Commands<'a> {
    fn new(ctx:&'a GpuContext)->Self{Self{ctx,current:ctx.device.create_command_encoder(&Default::default()),ready:Vec::new()}}
    fn checkpoint(&mut self){let next=self.ctx.device.create_command_encoder(&Default::default());self.ready.push(std::mem::replace(&mut self.current,next).finish());}
    fn finish(mut self)->Vec<wgpu::CommandBuffer>{self.ready.push(self.current.finish());self.ready}
}
impl std::ops::Deref for Commands<'_>{type Target=wgpu::CommandEncoder;fn deref(&self)->&Self::Target{&self.current}}
impl std::ops::DerefMut for Commands<'_>{fn deref_mut(&mut self)->&mut Self::Target{&mut self.current}}
struct Frame<'a> {
    width:u32,height:u32,channels:u32,matrix:Matrix,active_region:[u32;4],mask_regions:HashMap<usize,[u32;4]>,
    clips:HashMap<usize,Arc<RasterClip>>,clip_shapes:HashMap<u64,Vec<ClipShape>>,masks:HashMap<usize,Arc<InkSurface>>,mask_uses:HashMap<usize,usize>,
    scratch:InkSurface,stats:FrameStats,
    clip_buffers:HashMap<(usize,[u32;4]),Arc<wgpu::Buffer>>,
    clip_scratch:Option<Mask>,
    surfaces:&'a mut InkSurfacePool,cancel:&'a (dyn Fn()->bool+Sync),
}
// PERF (audit 2026-09-25 §R25.GPU.33): chỉ giữ và upload vùng clip có hiệu lực.
// Raster vẫn dùng tọa độ toàn frame để giữ nguyên quy tắc AA của tiny-skia.
struct ClipShape {paths:Vec<tiny_skia::Path>,rule:tiny_skia::FillRule,device_space:bool,parent:usize,value:Arc<RasterClip>}
struct RasterClip { mask:Mask,x:u32,y:u32 }
#[derive(Default)]
struct ClipRasterCache {key:Option<(u32,u32,Matrix)>,clips:HashMap<usize,Arc<RasterClip>>}

// PERF (audit 2026-09-27 §V27.D2): cùng phép nhân u8 chính xác nhưng duyệt
// lát hàng liên tục, bỏ chia/modulo và kiểm bounds cho từng pixel.
fn write_coverage_pairs(values:&mut[u32],start:usize,len:usize,product:impl Fn(usize)->u32){
    let mut i=0;let mut out=start/2;
    if start%2==1 && len>0{values[out]|=product(0)<<16;i=1;out+=1;}
    while i+1<len{values[out]=product(i)|(product(i+1)<<16);i+=2;out+=1;}
    if i<len{values[out]|=product(i);}
}
fn pack_coverage(pixels:Option<&[u8]>,w:u32,h:u32,x:u32,y:u32,clip:Option<&RasterClip>)->Vec<u32>{
    let mut values=vec![0;(w as usize*h as usize).div_ceil(2).max(1)];
    if let Some(clip)=clip {
        let left=x.max(clip.x);let right=x.saturating_add(w).min(clip.x.saturating_add(clip.mask.width()));
        let top=y.max(clip.y);let bottom=y.saturating_add(h).min(clip.y.saturating_add(clip.mask.height()));
        if right<=left || bottom<=top{return values;}
        let len=(right-left) as usize;
        for row in top..bottom{
            let start=((row-y)*w+left-x) as usize;let c=((row-clip.y)*clip.mask.width()+left-clip.x) as usize;
            let masks=&clip.mask.data()[c..c+len];
            if let Some(pixels)=pixels{let pixels=&pixels[start..start+len];write_coverage_pairs(&mut values,start,len,|i|u32::from(pixels[i])*u32::from(masks[i]));}
            else{write_coverage_pairs(&mut values,start,len,|i|255*u32::from(masks[i]));}
        }
    }else if let Some(pixels)=pixels{write_coverage_pairs(&mut values,0,pixels.len(),|i|u32::from(pixels[i])*255);}
    else{write_coverage_pairs(&mut values,0,w as usize*h as usize,|_|255*255);}
    values
}
#[cfg(test)]
mod coverage_packing_tests {
    use super::*;
    #[test]
    fn packed_rows_match_scalar_for_odd_widths_clips_and_offsets(){
        for w in 1..11 {for h in 1..7 {for offset in 0..9 {
            let pixels:Vec<u8>=(0..w*h).map(|i|((i*17+offset*31)%256) as u8).collect();
            let mut mask=Mask::new(5,6).unwrap();for(i,v)in mask.data_mut().iter_mut().enumerate(){*v=(i*23%256)as u8;}
            let clip=RasterClip{mask,x:offset,y:offset/2};
            for alpha in [Some(pixels.as_slice()),None]{for cut in [Some(&clip),None]{
                let got=pack_coverage(alpha,w,h,2,1,cut);let mut expected=vec![0;(w as usize*h as usize).div_ceil(2)];
                for i in 0..w*h{let product=u32::from(alpha.map_or(255,|p|p[i as usize]))*u32::from(cut.map_or(255,|c|c.sample(2+i%w,1+i/w)));expected[i as usize/2]|=product<<((i%2)*16);}
                assert_eq!(got,expected,"{w}x{h}, offset={offset}");
            }}
        }}}
    }
}
impl RasterClip {
    #[cfg(test)]
    fn sample(&self,x:u32,y:u32)->u8 {
        if x<self.x || y<self.y || x-self.x>=self.mask.width() || y-self.y>=self.mask.height() {return 0;}
        self.mask.data()[((y-self.y)*self.mask.width()+x-self.x) as usize]
    }
}
fn device_region(b:print_engine::geom::Rect,width:u32,height:u32)->[u32;4] {
    let x=(b.x0.floor()-2.).clamp(0.,width as f32) as u32;
    let y=(b.y0.floor()-2.).clamp(0.,height as f32) as u32;
    let right=(b.x1.ceil()+2.).clamp(x as f32,width as f32) as u32;
    let bottom=(b.y1.ceil()+2.).clamp(y as f32,height as f32) as u32;
    [x,y,right-x,bottom-y]
}
fn err(e:impl std::fmt::Display)->GpuError {GpuError::UnsupportedPass(e.to_string())}
fn ts(m:Matrix)->Transform {Transform::from_row(m.a,m.b,m.c,m.d,m.e,m.f)}
fn key<T>(arc:&Arc<T>)->usize {Arc::as_ptr(arc) as usize}

impl RetainedRenderer {
    pub fn new(ctx:&GpuContext,scene:Arc<RetainedPage>,cm:&ColorManager,format:wgpu::TextureFormat)->Result<Self,GpuError> {
        let resources=Arc::new(RendererResources::new(ctx,cm,format)?);
        let common=resources.preparation.clone();
        let mut renderer=Self::with_resources(ctx,scene,resources)?;
        renderer.preparation.lut_us=common.lut_us;renderer.preparation.pipelines_us+=common.pipelines_us;
        renderer.preparation.total_us+=common.total_us;
        Ok(renderer)
    }
    pub fn with_resources(ctx:&GpuContext,scene:Arc<RetainedPage>,resources:Arc<RendererResources>)->Result<Self,GpuError>{
        if ctx.identity()!=resources.gpu_id{return Err(err("Tài nguyên renderer thuộc GPU khác"));}
        let cm=resources.color.lock().map_err(err)?.fork_for_render().map_err(err)?;
        let started=std::time::Instant::now();
        let mut preparation=PrepareStats::default();
        // R34.06: skipped_ops là nhật ký parser, không phải capability gate.
        // Font thay thế và operator thông tin vẫn có scene/glyph để vẽ; chỉ các
        // cảnh báo chứng minh mất mực, transparency hoặc màu xấp xỉ mới buộc PPE.
        if scene.warnings.ink_unsound() {
            return Err(err(format!("Scene cần PPE dependency fallback: {:?}",scene.warnings)));
        }
        let mut space=scene.space.clone();
        // Đăng ký mọi kênh TRƯỚC upload; nếu texture cũ thiếu kênh mới, alpha sẽ
        // bị đọc nhầm thành spot. Scene và InkSpace sau bước này là bất biến.
        visit(&scene.commands,&mut |draw| {
            match &draw.kind {
                RetainedKind::Image {image,..}=> {
                    let mut warnings=Default::default();
                    let sampler=ImageSampler::new(image,&mut space,&mut warnings,Some(&cm)).map_err(err)?;
                    if image.stencil.is_none() {sampler.ink_at(0,0,&mut space,&mut warnings,Some(&cm)).map_err(err)?;}
                },
                RetainedKind::Shading {shading,..}=> {
                    let mut warnings=Default::default();
                    let components=shading.colorspace.initial_components();
                    shading.colorspace.to_ink(&components,&mut space,&mut warnings,Some(&cm)).map_err(err)?;
                },_=>{}
            }
            if draw.blend_space==BlendSpace::DeviceRgb || !draw.paint.blend.is_separable() {
                return Err(err("Group RGB/non-separable cần dependency fallback trước ICC"));
            }
            Ok(())
        })?;
        preparation.validate_us=started.elapsed().as_micros();
        // Chỉ dựng material sau culling của frame cần nó. Bản overview vẫn vẽ
        // đủ nội dung; không giảm mẫu ảnh hoặc bỏ dependency transparency.
        let phase=std::time::Instant::now();
        let resolve=Arc::new(IccResolve::with_resources(ctx,resources.resolve.clone(),&space)?);
        let mut bounds=HashMap::new();visit(&scene.commands,&mut |draw| {bounds.insert(draw as *const _ as usize,draw_bounds(draw));Ok(())})?;
        preparation.pipelines_us=phase.elapsed().as_micros();preparation.total_us=started.elapsed().as_micros();
        Ok(Self{preparation,scene,space,materials:Arc::new(Mutex::new(HashMap::new())),resources,resolve,
            surfaces:Mutex::new(InkSurfacePool::default()),bounds:Arc::new(bounds),fallback_color:Mutex::new(cm),clip_cache:Mutex::new(ClipRasterCache::default())})
    }
    /// Mỗi viewport có scratch/pool và LCMS riêng. Chỉ scene/material/pipeline
    /// bất biến được chia sẻ, tránh command chưa submit bị viewport khác ghi đè.
    pub fn fork_for_view(&self)->Result<Self,GpuError>{
        Ok(Self{preparation:Default::default(),scene:self.scene.clone(),space:self.space.clone(),
            materials:self.materials.clone(),resources:self.resources.clone(),resolve:self.resolve.clone(),
            surfaces:Mutex::new(InkSurfacePool::default()),bounds:self.bounds.clone(),
            clip_cache:Mutex::new(ClipRasterCache::default()),
            fallback_color:Mutex::new(self.fallback_color.lock().map_err(err)?.fork_for_render().map_err(err)?)})
    }
    pub fn material_count(&self)->usize{self.materials.lock().map(|m|m.len()).unwrap_or(0)}
    /// Device/surface lỗi thì bỏ resource tạm trước khi presenter chuyển sang
    /// nhánh phục hồi. Scene và material cache vẫn được giữ.
    pub fn clear_frame_resources(&self) {
        if let Ok(mut surfaces) = self.surfaces.lock() { surfaces.clear(); }
    }
    fn material(&self,id:usize,build:impl FnOnce(&mut InkSpace,&ColorManager)->Result<Material,GpuError>)->Result<(Arc<Material>,bool),GpuError>{
        let mut materials=self.materials.lock().map_err(err)?;
        if let Some(value)=materials.get(&id){return Ok((value.clone(),false));}
        let color=self.fallback_color.lock().map_err(err)?;
        let value=Arc::new(build(&mut self.space.clone(),&color)?);
        materials.insert(id,value.clone());Ok((value,true))
    }
    pub fn render(&self,ctx:&GpuContext,output:&wgpu::TextureView,width:u32,height:u32,matrix:Matrix)->Result<FrameStats,GpuError> {
        self.with_prepared(ctx,output,width,height,matrix,|prepared|{
            ctx.queue.submit(prepared.commands);prepared.stats
        })
    }

    /// Chỉ giải phóng pool khi consumer đã submit HOẶC hủy tất cả lệnh.
    /// Callback chạy ở worker encode; không đưa mutex/coverage CPU lên luồng UI.
    pub fn with_prepared<T>(&self,ctx:&GpuContext,output:&wgpu::TextureView,width:u32,height:u32,matrix:Matrix,
        consume:impl FnOnce(PreparedFrame)->T)->Result<T,GpuError> {
        self.with_prepared_cancellable(ctx,output,width,height,matrix,&||false,consume)
    }
    /// Hủy tại biên primitive/clip; không submit frame dở dang hoặc đổi backend.
    pub fn with_prepared_cancellable<T>(&self,ctx:&GpuContext,output:&wgpu::TextureView,width:u32,height:u32,matrix:Matrix,
        cancel:&(dyn Fn()->bool+Sync),consume:impl FnOnce(PreparedFrame)->T)->Result<T,GpuError> {
        self.with_prepared_region_cancellable(ctx,output,width,height,matrix,None,cancel,consume)
    }
    /// PERF (audit 2026-09-27 §V27.D1/D2): ROI chỉ cull/dispatch/đóng gói.
    /// Raster path/clip giữ nguyên gốc và kích thước camera để không đổi AA.
    pub fn with_prepared_region_cancellable<T>(&self,ctx:&GpuContext,output:&wgpu::TextureView,width:u32,height:u32,matrix:Matrix,region:Option<[u32;4]>,
        cancel:&(dyn Fn()->bool+Sync),consume:impl FnOnce(PreparedFrame)->T)->Result<T,GpuError> {
        if region.is_some_and(|[x,y,w,h]|w==0 || h==0 || x.checked_add(w).is_none_or(|r|r>width) || y.checked_add(h).is_none_or(|b|b>height)){return Err(err("Vùng refine nằm ngoài surface"));}
        let started=std::time::Instant::now();
        if cancel(){return Err(err("Frame đã bị thay thế"));}
        if ctx.identity()!=self.resources.gpu_id{return Err(err("Frame thuộc GPU khác"));}
        if [matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f].iter().any(|v|!v.is_finite()) {return Err(err("Camera không hữu hạn"));}
        let channels=self.space.len() as u32;
        let mut encoder=Commands::new(ctx);
        let mut surfaces=self.surfaces.lock().map_err(err)?;surfaces.begin_frame(width,height,channels);
        let mut clip_cache=self.clip_cache.lock().map_err(err)?;
        let clips=if clip_cache.key==Some((width,height,matrix)){std::mem::take(&mut clip_cache.clips)}else{clip_cache.clips.clear();HashMap::new()};
        let reused=clips.len();
        let target=surfaces.take(ctx,&mut encoder)?;let scratch=surfaces.take(ctx,&mut encoder)?;
        let active_region=intersect_region(region.unwrap_or([0,0,width,height]),[0,0,width,height]);
        let mut frame=Frame {width,height,channels,matrix,active_region,mask_regions:mask_regions(&self.scene.commands,&self.bounds,matrix,width,height,active_region),clips,clip_shapes:HashMap::new(),masks:HashMap::new(),mask_uses:mask_uses(&self.scene.commands),scratch,stats:FrameStats{clip_cache_reused:reused,..Default::default()},clip_buffers:HashMap::new(),clip_scratch:None,surfaces:&mut surfaces,cancel};
        self.resources.compositor.encode(ctx,&mut encoder,&target,None,None,None,None,&[],&target.dispatch(0))?;
        self.draws(ctx,&mut encoder,&target,None,&self.scene.commands,&mut frame)?;
        let page=map_bounds(self.scene.bounds,matrix);
        self.resolve.encode_page(ctx,&mut encoder,&target,output,[page.x0,page.y0,page.x1,page.y1])?;
        frame.stats.content_proof=if page.x1>0. && page.y1>0. && page.x0<(width as f32) && page.y0<(height as f32){FrameContentProof::PpeRetained}else{FrameContentProof::OutsidePage};
        frame.stats.encode_us=started.elapsed().as_micros();
        if cancel(){return Err(err("Frame đã bị thay thế"));}
        clip_cache.key=Some((width,height,matrix));clip_cache.clips=std::mem::take(&mut frame.clips);drop(clip_cache);
        let prepared=PreparedFrame{commands:encoder.finish(),stats:frame.stats};
        Ok(consume(prepared))
    }

    fn draws(&self,ctx:&GpuContext,e:&mut Commands<'_>,target:&InkSurface,knockout:Option<&InkSurface>,draws:&[RetainedDraw],frame:&mut Frame)->Result<(),GpuError> {
        let mut index=0;
        while index<draws.len() {
            if (frame.cancel)(){return Err(err("Frame đã bị thay thế"));}
            let draw=&draws[index];
            let (merged,consumed)=coalesce_paths(&draws[index..],frame.matrix,knockout.is_some());index+=consumed;
            let bounds=if let Some(path)=&merged {let b=path.bounds();map_bounds(print_engine::geom::Rect::new(b.left(),b.top(),b.right(),b.bottom()),frame.matrix)}
                else {map_bounds(self.bounds[&(draw as *const _ as usize)],frame.matrix)};
            if bounds.x1 < -2. || bounds.y1 < -2. || bounds.x0 > frame.width as f32+2. || bounds.y0 > frame.height as f32+2. {
                frame.stats.culled+=1;continue;
            }
            let affected=intersect_region(device_region(bounds,frame.width,frame.height),frame.active_region);
            if affected[2]==0 || affected[3]==0 {frame.stats.culled+=1;continue;}
            let mask=if let Some(mask)=&draw.state.mask {Some(self.mask(ctx,e,mask,frame)?)}else{None};
            let mut p=parameters(target,draw);p.region=intersect_region(device_region(bounds,frame.width,frame.height),frame.active_region);p.flags[1]=knockout.is_some() as u32;p.participation[3]=mask.is_some() as u32;
            match &draw.kind {
                RetainedKind::Path {..}|RetainedKind::Stroke {..}=> {
                    let (path,rule)=match &draw.kind {
                        RetainedKind::Path {path,rule}=>(merged.unwrap_or_else(||path.clone()).transform(ts(frame.matrix)),*rule),
                        RetainedKind::Stroke {path,matrix,style}=>(style.device_path(path,matrix.then(&frame.matrix)),print_engine::raster::FillRule::NonZero),_=>unreachable!(),
                    };
                    let Some(path)=path else {drop(mask);release_mask(draw.state.mask.as_ref(),frame);continue;};
                    let b=path.bounds();let x=(b.left().floor()-1.).max(0.).min(frame.width as f32) as u32;
                    let y=(b.top().floor()-1.).max(0.).min(frame.height as f32) as u32;
                    let right=(b.right().ceil()+1.).max(0.).min(frame.width as f32) as u32;
                    let bottom=(b.bottom().ceil()+1.).max(0.).min(frame.height as f32) as u32;
                    if right<=x || bottom<=y {drop(mask);release_mask(draw.state.mask.as_ref(),frame);frame.stats.culled+=1;continue;}
                    let w=right-x;let h=bottom-y;
                    let mut coverage=Mask::new(w,h).ok_or_else(||err("Không cấp được coverage path"))?;
                    coverage.fill_path(&path,rule.into(),true,Transform::from_translate(-(x as f32),-(y as f32)));
                    let clip=self.clip(draw.state.clip.as_ref(),frame)?;
                    let [dx,dy,dw,dh]=intersect_region([x,y,w,h],frame.active_region);
                    if dw==0 || dh==0 {drop(mask);release_mask(draw.state.mask.as_ref(),frame);frame.stats.culled+=1;continue;}
                    let cropped=if [dx,dy,dw,dh]!=[x,y,w,h]{
                        let mut data=Vec::with_capacity(dw as usize*dh as usize);
                        for row in dy..dy+dh{let start=((row-y)*w+dx-x)as usize;data.extend_from_slice(&coverage.data()[start..start+dw as usize]);}Some(data)
                    }else{None};
                    let values=pack_coverage(Some(cropped.as_deref().unwrap_or(coverage.data())),dw,dh,dx,dy,clip.as_deref());
                    if values.iter().all(|v|*v==0) {drop(mask);release_mask(draw.state.mask.as_ref(),frame);frame.stats.culled+=1;continue;}
                    frame.stats.coverage_bytes+=values.len()*4;
                    let coverage=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:Some("PPE path coverage"),contents:bytemuck::cast_slice(&values),usage:wgpu::BufferUsages::STORAGE});
                    p.region=[dx,dy,dw,dh];p.participation[2]=4;
                    self.resources.compositor.encode(ctx,e,target,None,knockout,Some(&coverage),mask.as_ref().map(|m|&m.buffer),&draw.paint.ink,&p)?;
                },
                RetainedKind::Image {image,matrix,interpolate}=> {
                    let began=std::time::Instant::now();
                    let (material,built)=self.material(key(image),|space,cm|Material::image_cancellable(ctx,image,space,cm,frame.cancel))?;
                    frame.stats.material_prepare_us+=began.elapsed().as_micros();frame.stats.material_builds+=usize::from(built);
                    e.clear_buffer(&frame.scratch.buffer,0,None);
                    self.resources.sampler.encode_region(ctx,e,&frame.scratch,&material,matrix.then(&frame.matrix),*interpolate,p.region)?;
                    let clip=self.clip_buffer(ctx,draw.state.clip.as_ref(),p.region,frame)?;
                    p.extent[3]=2;p.flags[3]=1;p.participation[2]=if clip.is_some(){4}else{0};
                    // Stencil mang shape, màu lấy ở graphics state tại invocation.
                    if material.stencil {p.extent[3]=4;}else{
                        p.participation[0]=0;p.participation[1]=0;
                        for ch in 0..frame.channels {if material.declared.contains(ch as usize) {p.participation[(ch/32) as usize]|=1<<(ch%32);}}
                        if draw.state.overprint_mode==1 && matches!(image.colorspace,Some(print_engine::color::ColorSpace::DeviceCMYK)) {p.flags[2]|=2;}
                    }
                    self.resources.compositor.encode(ctx,e,target,Some(&frame.scratch),knockout,clip.as_deref(),mask.as_ref().map(|m|&m.buffer),&draw.paint.ink,&p)?;
                },
                RetainedKind::Shading {shading,matrix}=> {
                    e.clear_buffer(&frame.scratch.buffer,0,None);
                    let declared=if matches!(shading.kind,print_engine::shading::ShadingKind::Axial{..}|print_engine::shading::ShadingKind::Radial{..}) {
                        let began=std::time::Instant::now();
                        let (material,built)=self.material(key(shading),|space,cm|Material::shading(ctx,shading,space,cm))?;
                        frame.stats.material_prepare_us+=began.elapsed().as_micros();frame.stats.material_builds+=usize::from(built);
                        self.resources.sampler.encode_region(ctx,e,&frame.scratch,&material,matrix.then(&frame.matrix),false,p.region)?;material.declared
                    }else{
                        let cm=self.fallback_color.lock().map_err(err)?;
                        crate::retained_fallback::shading(ctx,e,&frame.scratch,shading,matrix.then(&frame.matrix),&self.space,&cm)?
                    };
                    let clip=self.clip_buffer(ctx,draw.state.clip.as_ref(),p.region,frame)?;
                    p.extent[3]=2;p.flags[3]=1;p.participation[2]=if clip.is_some(){4}else{0};
                    p.participation[0]=0;p.participation[1]=0;
                    for ch in 0..frame.channels {if declared.contains(ch as usize){p.participation[(ch/32) as usize]|=1<<(ch%32);}}
                    if draw.state.overprint_mode==1 && matches!(shading.colorspace,print_engine::color::ColorSpace::DeviceCMYK|print_engine::color::ColorSpace::IccBased{..}){p.flags[2]|=2;}
                    self.resources.compositor.encode(ctx,e,target,Some(&frame.scratch),knockout,clip.as_deref(),mask.as_ref().map(|m|&m.buffer),&[],&p)?;
                },
                RetainedKind::Group {commands,isolated,knockout:child_knockout,..}=> {
                    let initial=frame.surfaces.take(ctx,e)?;
                    if !isolated {e.copy_buffer_to_buffer(&knockout.unwrap_or(target).buffer,0,&initial.buffer,0,initial.buffer.size());}
                    let child=frame.surfaces.take(ctx,e)?;
                    e.copy_buffer_to_buffer(&initial.buffer,0,&child.buffer,0,child.buffer.size());
                    self.resources.compositor.encode(ctx,e,&child,None,None,None,None,&[],&child.dispatch(1))?;
                    self.draws(ctx,e,&child,child_knockout.then_some(&initial),commands,frame)?;
                    p.extent[3]=2;p.flags[3]=*isolated as u32;
                    // Clip cha đã có trên từng primitive con; không nhân biên AA lần hai.
                    self.resources.compositor.encode(ctx,e,target,Some(&child),Some(knockout.unwrap_or(&initial)),None,mask.as_ref().map(|m|&m.buffer),&[],&p)?;
                    frame.surfaces.recycle(child);frame.surfaces.recycle(initial);
                    frame.stats.groups+=1;
                },
            }
            drop(mask);release_mask(draw.state.mask.as_ref(),frame);
            frame.stats.draws+=1;
            e.checkpoint();
        }Ok(())
    }

    fn clip(&self,clip:Option<&Arc<RetainedClip>>,frame:&mut Frame)->Result<Option<Arc<RasterClip>>,GpuError> {
        let Some(clip)=clip else{return Ok(None);};
        if let Some(value)=frame.clips.get(&key(clip)) {return Ok(Some(value.clone()));}
        let parent=self.clip(clip.parent.as_ref(),frame)?;
        let phase=std::time::Instant::now();
        let stroke=clip.stroke.as_ref().and_then(|s|s.style.device_path(&s.path,s.matrix.then(&frame.matrix)));
        let paths:Vec<_>=if clip.stroke.is_some() {stroke.iter().collect()} else {clip.paths.iter().collect()};
        let transform=if clip.stroke.is_some(){Transform::identity()}else{ts(frame.matrix)};
        // Các Form lặp lại tạo Arc clip khác nhau nhưng hình học giống hệt.
        // Băm chỉ tìm bucket; so sánh đầy đủ trước reuse để không phụ thuộc collision.
        let device_space=clip.stroke.is_some();
        let rule=if device_space {tiny_skia::FillRule::Winding}else{clip.rule.into()};
        let parent_id=parent.as_ref().map_or(0,|p|key(p));
        let mut hash=std::collections::hash_map::DefaultHasher::new();
        parent_id.hash(&mut hash);device_space.hash(&mut hash);std::mem::discriminant(&rule).hash(&mut hash);
        for path in &paths {
            path.points().len().hash(&mut hash);
            for point in path.points(){point.x.to_bits().hash(&mut hash);point.y.to_bits().hash(&mut hash);}
            for segment in path.segments(){std::mem::discriminant(&segment).hash(&mut hash);}
        }
        let signature=hash.finish();
        if let Some(entry)=frame.clip_shapes.get(&signature).and_then(|entries|entries.iter().find(|e|
            e.rule==rule && e.device_space==device_space && e.parent==parent_id && e.paths.len()==paths.len()
                && e.paths.iter().zip(&paths).all(|(a,b)|a==*b))) {
            let value=entry.value.clone();frame.clips.insert(key(clip),value.clone());return Ok(Some(value));
        }
        let saved_paths=paths.iter().map(|p|(*p).clone()).collect();

        let bounds=paths.iter().map(|p| {
            let b=p.bounds();let r=print_engine::geom::Rect::new(b.left(),b.top(),b.right(),b.bottom());
            if clip.stroke.is_some(){r}else{map_bounds(r,frame.matrix)}
        }).reduce(|a,b|print_engine::geom::Rect::new(a.x0.min(b.x0),a.y0.min(b.y0),a.x1.max(b.x1),a.y1.max(b.y1)))
            .unwrap_or(print_engine::geom::Rect::new(0.,0.,0.,0.));
        let [mut x,mut y,w,h]=device_region(bounds,frame.width,frame.height);
        let (mut right,mut bottom)=(x+w,y+h);
        if let Some(parent)=&parent {
            x=x.max(parent.x);y=y.max(parent.y);
            right=right.min(parent.x+parent.mask.width()).max(x);
            bottom=bottom.min(parent.y+parent.mask.height()).max(y);
        }
        let (w,h)=(right-x,bottom-y);
        let mut union=Mask::new(w.max(1),h.max(1)).ok_or_else(||err("Không cấp được vùng clip"))?;
        if w>0 && h>0 {
            // Không tịnh tiến path sang ô: phép clipping/AA giữ đúng ảnh trước sửa.
            for path in paths {
                if (frame.cancel)(){return Err(err("Frame đã bị thay thế"));}
                let mut part=match frame.clip_scratch.take(){Some(mut part)=>{part.data_mut().fill(0);part},None=>Mask::new(frame.width,frame.height).ok_or_else(||err("Không cấp được clip path"))?};
                let rule=if clip.stroke.is_some(){tiny_skia::FillRule::Winding}else{clip.rule.into()};
                part.fill_path(path,rule,true,transform);
                for row in 0..h {
                    let src=&part.data()[((y+row)*frame.width+x) as usize..((y+row)*frame.width+x+w) as usize];
                    let dst=&mut union.data_mut()[(row*w) as usize..((row+1)*w) as usize];
                    for (dst,src) in dst.iter_mut().zip(src) {*dst=(*dst).max(*src);}
                }
                frame.clip_scratch=Some(part);
            }
            if let Some(parent)=parent {
                for row in 0..h {
                    let start=((y+row-parent.y)*parent.mask.width()+x-parent.x) as usize;
                    let source=&parent.mask.data()[start..start+w as usize];
                    let dest=&mut union.data_mut()[(row*w) as usize..((row+1)*w) as usize];
                    for (d,s) in dest.iter_mut().zip(source){*d=((u32::from(*d)*u32::from(*s)+127)/255) as u8;}
                }
            }
        }
        frame.stats.clip_us+=phase.elapsed().as_micros();frame.stats.clip_pixels+=union.data().len();
        let value=Arc::new(RasterClip{mask:union,x,y});
        frame.clip_shapes.entry(signature).or_default().push(ClipShape{paths:saved_paths,rule,device_space,parent:parent_id,value:value.clone()});
        frame.clips.insert(key(clip),value.clone());Ok(Some(value))
    }
    fn clip_buffer(&self,ctx:&GpuContext,clip:Option<&Arc<RetainedClip>>,region:[u32;4],frame:&mut Frame)->Result<Option<Arc<wgpu::Buffer>>,GpuError> {
        let Some(clip)=clip else{return Ok(None);};
        let resolved=self.clip(Some(clip),frame)?;
        let Some(resolved)=resolved else{return Ok(None);};let id=(key(&resolved),region);
        if let Some(buffer)=frame.clip_buffers.get(&id) {return Ok(Some(buffer.clone()));}
        let buffer=Some(resolved).map(|mask| {
            let [x,y,w,h]=region;let values=pack_coverage(None,w,h,x,y,Some(&mask));
            frame.stats.coverage_bytes+=values.len()*4;
            Arc::new(ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:Some("PPE clip coverage region"),contents:bytemuck::cast_slice(&values),usage:wgpu::BufferUsages::STORAGE}))
        });
        if let Some(buffer)=&buffer {frame.clip_buffers.insert(id,buffer.clone());}
        Ok(buffer)
    }
    fn mask(&self,ctx:&GpuContext,e:&mut Commands<'_>,mask:&Arc<RetainedMask>,frame:&mut Frame)->Result<Arc<InkSurface>,GpuError> {
        if let Some(value)=frame.masks.get(&key(mask)) {return Ok(value.clone());}
        let target=frame.surfaces.take(ctx,e)?;
        let region=frame.mask_regions[&key(mask)];
        let mut init=target.dispatch(0);init.region=region;init.opacity[0]=mask.backdrop.alpha;
        self.resources.compositor.encode(ctx,e,&target,None,None,None,None,&mask.backdrop.ink,&init)?;
        let previous=frame.active_region;frame.active_region=region;
        let result=self.draws(ctx,e,&target,None,&mask.commands,frame);frame.active_region=previous;result?;
        let result=frame.surfaces.take(ctx,e)?;
        let mut p=result.dispatch(3);p.region=region;p.flags[0]=mask.luminosity as u32;p.opacity[3]=mask.transfer.is_some() as u32 as f32;
        self.resources.compositor.encode(ctx,e,&result,Some(&target),None,None,None,mask.transfer.as_deref().unwrap_or(&[]),&p)?;
        frame.surfaces.recycle(target);
        let result=Arc::new(result);frame.masks.insert(key(mask),result.clone());frame.stats.masks+=1;frame.stats.peak_masks=frame.stats.peak_masks.max(frame.masks.len());Ok(result)
    }
}

// PERF (audit 2026-09-25 §R25.GPU.31): mask chỉ cần sống đến invocation cuối.
// Command giữ handle; pool ghi lại ở lệnh SAU composite nên không đổi backdrop.
// Mỗi closure mask được encode một lần; không nhân số dùng theo số caller của nó.
fn intersect_region(a:[u32;4],b:[u32;4])->[u32;4] {
    let x=a[0].max(b[0]);let y=a[1].max(b[1]);
    [x,y,(a[0]+a[2]).min(b[0]+b[2]).saturating_sub(x),(a[1]+a[3]).min(b[1]+b[3]).saturating_sub(y)]
}
// Vùng mask phải hợp TẤT CẢ invocation, kể cả mask dùng lại trong nhiều nhóm.
// Không cắt theo invocation đầu, không đổi BC/TR hoặc shape/knockout.
fn mask_regions(draws:&[RetainedDraw],bounds:&HashMap<usize,print_engine::geom::Rect>,matrix:Matrix,width:u32,height:u32,demand:[u32;4])->HashMap<usize,[u32;4]> {
    fn walk(ds:&[RetainedDraw],bounds:&HashMap<usize,print_engine::geom::Rect>,m:Matrix,w:u32,h:u32,
        demand:[u32;4],regions:&mut HashMap<usize,[u32;4]>,seen:&mut HashSet<usize>) {
        for draw in ds {
            if let Some(mask)=&draw.state.mask {
                // PERF (audit 2026-09-27 §V27.R3): mọi phép trộn mask/BC/TR
                // đều theo cùng pixel. Union TẤT CẢ invocation trong ROI gốc,
                // kể cả nested/reused mask; không mở active_region ra ngoài
                // nhu cầu frame và không cắt riêng theo invocation đầu tiên.
                let b=intersect_region(device_region(map_bounds(bounds[&(draw as *const _ as usize)],m),w,h),demand);
                if b[2]>0 && b[3]>0 {regions.entry(key(mask)).and_modify(|a| {
                    let x=a[0].min(b[0]);let y=a[1].min(b[1]);
                    *a=[x,y,(a[0]+a[2]).max(b[0]+b[2])-x,(a[1]+a[3]).max(b[1]+b[3])-y];
                }).or_insert(b);}
                if seen.insert(key(mask)) {walk(&mask.commands,bounds,m,w,h,demand,regions,seen);}
            }
            if let RetainedKind::Group{commands,..}=&draw.kind {walk(commands,bounds,m,w,h,demand,regions,seen);}
        }
    }
    let mut result=HashMap::new();walk(draws,bounds,matrix,width,height,demand,&mut result,&mut HashSet::new());result
}
fn mask_uses(draws:&[RetainedDraw])->HashMap<usize,usize>{
    fn walk(ds:&[RetainedDraw],uses:&mut HashMap<usize,usize>,seen:&mut HashSet<usize>){
        for d in ds{
            if let Some(mask)=&d.state.mask{
                *uses.entry(key(mask)).or_default()+=1;
                if seen.insert(key(mask)){walk(&mask.commands,uses,seen);}
            }
            if let RetainedKind::Group{commands,..}=&d.kind{walk(commands,uses,seen);}
        }
    }
    let mut uses=HashMap::new();walk(draws,&mut uses,&mut HashSet::new());uses
}
fn release_mask(mask:Option<&Arc<RetainedMask>>,frame:&mut Frame){
    let Some(mask)=mask else{return;};let id=key(mask);
    let Some(remaining)=frame.mask_uses.get_mut(&id) else{return;};
    *remaining-=1;
    if *remaining==0{
        if let Some(surface)=frame.masks.remove(&id){
            if let Ok(surface)=Arc::try_unwrap(surface){frame.surfaces.recycle(surface);}
        }
    }
}

fn map_bounds(b:print_engine::geom::Rect,m:Matrix)->print_engine::geom::Rect {
    let points=[m.apply(b.x0,b.y0),m.apply(b.x1,b.y0),m.apply(b.x0,b.y1),m.apply(b.x1,b.y1)];
    print_engine::geom::Rect::new(points.iter().map(|v|v.0).fold(f32::INFINITY,f32::min),points.iter().map(|v|v.1).fold(f32::INFINITY,f32::min),
        points.iter().map(|v|v.0).fold(f32::NEG_INFINITY,f32::max),points.iter().map(|v|v.1).fold(f32::NEG_INFINITY,f32::max))
}
fn draw_bounds(draw:&RetainedDraw)->print_engine::geom::Rect {
    use print_engine::geom::Rect;
    let mut bounds=match &draw.kind {
        RetainedKind::Path {path,..}=>{let b=path.bounds();Rect::new(b.left(),b.top(),b.right(),b.bottom())},
        // Hairline có độ rộng theo thiết bị; clip vẫn cull được mà không cắt nhầm nét.
        RetainedKind::Stroke {..}=>Rect::new(-1e15,-1e15,1e15,1e15),
        RetainedKind::Image {matrix,..}=>map_bounds(Rect::new(0.,0.,1.,1.),*matrix),
        RetainedKind::Shading {shading,matrix}=>shading.bbox.map(|b|map_bounds(b,*matrix)).unwrap_or(Rect::new(-1e15,-1e15,1e15,1e15)),
        RetainedKind::Group {commands,..}=>commands.iter().map(draw_bounds).reduce(|a,b|Rect::new(a.x0.min(b.x0),a.y0.min(b.y0),a.x1.max(b.x1),a.y1.max(b.y1))).unwrap_or(Rect::new(0.,0.,0.,0.)),
    };
    let mut clip=draw.state.clip.as_ref();
    while let Some(c)=clip {
        // Stroke clip không nằm trong paths; dùng biên đối tượng bảo thủ.
        if c.stroke.is_some(){clip=c.parent.as_ref();continue;}
        let b=c.paths.iter().map(|p|p.bounds()).map(|b|Rect::new(b.left(),b.top(),b.right(),b.bottom()))
            .reduce(|a,b|Rect::new(a.x0.min(b.x0),a.y0.min(b.y0),a.x1.max(b.x1),a.y1.max(b.y1))).unwrap_or(Rect::new(0.,0.,0.,0.));
        bounds=bounds.intersect(&b).unwrap_or(Rect::new(0.,0.,0.,0.));clip=c.parent.as_ref();
    }bounds
}

fn parameters(target:&InkSurface,draw:&RetainedDraw)->InkDispatch {
    let mut p=target.dispatch(0);p.opacity[0]=draw.paint.alpha;p.opacity[2]=draw.state.alpha_is_shape as u32 as f32;
    p.flags[0]=match draw.paint.blend {BlendMode::Normal=>0,BlendMode::Multiply=>1,BlendMode::Screen=>2,BlendMode::Overlay=>3,BlendMode::Darken=>4,BlendMode::Lighten=>5,
        BlendMode::ColorDodge=>6,BlendMode::ColorBurn=>7,BlendMode::HardLight=>8,BlendMode::SoftLight=>9,BlendMode::Difference=>10,BlendMode::Exclusion=>11,_=>0};
    p.flags[2]=draw.paint.overprint as u32;p.participation[0]=0;p.participation[1]=0;
    for ch in 0..target.channels {if draw.paint.declared.contains(ch as usize) {p.participation[(ch/32) as usize]|=1<<(ch%32);}}
    p
}
/// Gom primitive đục cùng paint khi bbox thiết bị KHÔNG chạm nhau (kể cả lề AA).
/// Không đổi thứ tự các primitive giao nhau, opacity, mask hay knockout.
fn coalesce_paths(draws:&[RetainedDraw],matrix:Matrix,knockout:bool)->(Option<tiny_skia::Path>,usize) {
    let first=&draws[0];
    let RetainedKind::Path {path,rule}=&first.kind else{return (None,1);};
    if knockout || first.paint.alpha!=1. || first.paint.blend!=BlendMode::Normal || first.state.mask.is_some() {return (None,1);}
    let clip=first.state.clip.as_ref().map(key);
    let screen_bounds=|path:&tiny_skia::Path| {let b=path.bounds();let b=map_bounds(print_engine::geom::Rect::new(b.left(),b.top(),b.right(),b.bottom()),matrix);
        print_engine::geom::Rect::new(b.x0-1.,b.y0-1.,b.x1+1.,b.y1+1.)};
    let mut boxes=vec![screen_bounds(path)];let mut count=1;
    for next in &draws[1..] {
        let RetainedKind::Path {path,rule:next_rule}=&next.kind else{break;};
        if next_rule!=rule || next.paint.ink!=first.paint.ink || next.paint.alpha!=1. || next.paint.blend!=BlendMode::Normal ||
            next.paint.overprint!=first.paint.overprint || next.paint.declared!=first.paint.declared ||
            next.state.overprint_mode!=first.state.overprint_mode || next.state.alpha_is_shape!=first.state.alpha_is_shape || next.blend_space!=first.blend_space ||
            next.state.mask.is_some() || next.state.clip.as_ref().map(key)!=clip {break;}
        let bounds=screen_bounds(path);if boxes.iter().any(|b|b.intersect(&bounds).is_some()){break;}
        boxes.push(bounds);count+=1;
    }
    if count==1 {return (None,1);}
    let mut builder=tiny_skia::PathBuilder::new();
    for draw in &draws[..count] {if let RetainedKind::Path {path,..}=&draw.kind {builder.push_path(path);}}
    (builder.finish(),count)
}
fn visit(draws:&[RetainedDraw],f:&mut impl FnMut(&RetainedDraw)->Result<(),GpuError>)->Result<(),GpuError> {
    for draw in draws {
        f(draw)?;
        if let Some(mask)=&draw.state.mask {visit(&mask.commands,f)?;}
        if let RetainedKind::Group {commands,..}=&draw.kind {visit(commands,f)?;}
    }Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use print_engine::{content::RenderOptions,color::RenderIntent,page::{render_page_managed,PageBox}};
    use lopdf::{dictionary,Document,Stream,Object};
    #[test]
    fn pattern_stroke_and_fill_match_explicit_geometry_at_two_camera_scales() {
        let mut doc=Document::with_version("1.7");let pages=doc.new_object_id();
        let cell=Stream::new(dictionary!{"PatternType"=>1,"PaintType"=>1,"TilingType"=>1,
            "BBox"=>vec![0.into(),0.into(),5.into(),5.into()],"XStep"=>10,"YStep"=>10,"Resources"=>dictionary!{}},b"1 0 0 0 k 0 0 5 5 re f".to_vec());
        let data=doc.add_object(Stream::new(Default::default(),b"/Pattern cs /P scn 0 0 100 50 re f /Pattern CS /P SCN /G gs 6 w [12 8] 0 d 0 72 m 100 72 l S".to_vec()));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()],"Contents"=>data,
            "Resources"=>dictionary!{"Pattern"=>dictionary!{"P"=>Object::Stream(cell)},"ExtGState"=>dictionary!{"G"=>dictionary!{"CA"=>0.5}}}});
        doc.objects.insert(pages,dictionary!{"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into());let cat=doc.add_object(dictionary!{"Type"=>"Catalog","Pages"=>pages});doc.trailer.set("Root",cat);
        let cm=color();let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(&cm)).unwrap());
        // Oracle hình học độc lập: ô 5×5, dash [12 8], nét y=72 rộng 6.
        // PPE pattern stroke cũ bỏ CA và dash; không lấy lỗi đó làm golden.
        let mut reference=doc.clone();let mut explicit=String::from("1 0 0 0 k ");
        for y in (0..50).step_by(10){for x in (0..100).step_by(10){explicit.push_str(&format!("{x} {y} 5 5 re f "));}}
        explicit.push_str("/A gs ");
        for x in (0..100).step_by(20){explicit.push_str(&format!("{x} 70 5 5 re f {} 70 2 5 re f ",x+10));}
        reference.objects.insert(data,Object::Stream(Stream::new(Default::default(),explicit.into_bytes())));
        reference.get_dictionary_mut(page).unwrap().set("Resources",dictionary!{"ExtGState"=>dictionary!{"A"=>dictionary!{"ca"=>0.5}}});
        let ctx=GpuContext::new_sync().unwrap();let renderer=RetainedRenderer::new(&ctx,scene,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
        for scale in [1.,2.] {let size=(100.*scale) as u32;let out=ctx.create_target_texture(size,size,wgpu::TextureFormat::Rgba8Unorm,None);
            renderer.render(&ctx,&out.create_view(&Default::default()),size,size,renderer.scene.page_to_view(scale,0.,0.)).unwrap();
            let got=ctx.readback_texture_rgba8(&out,size,size).unwrap();let reference=render_page_managed(&reference,1,72.*scale,PageBox::Crop,RenderOptions::viewer(),Some(&cm)).unwrap();let rgb=reference.buffer.to_srgb(&cm).unwrap();
            for (i,(a,b)) in got.chunks_exact(4).zip(rgb.chunks_exact(3)).enumerate(){for c in 0..3{assert!(a[c].abs_diff(b[c])<=3,"scale={scale} pixel={i} {a:?} != {b:?}");}}
        }
    }

    #[test]
    fn real_pdf_scene_to_gpu_matches_ppe_for_clip_alpha_and_group() {
        let mut doc=Document::with_version("1.7");let pages=doc.new_object_id();
        let form=doc.add_object(Stream::new(dictionary! {"Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),40.into(),40.into()],
            "Group"=>dictionary! {"S"=>"Transparency","I"=>true}},b"1 0 0 0 k 0 0 40 40 re f".to_vec()));
        let data=doc.add_object(Stream::new(Default::default(),b"0 1 0 0 k 0 0 100 100 re f q 10 10 20 20 re W n /half gs /F Do Q".to_vec()));
        let page=doc.add_object(dictionary! {"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()],"Contents"=>data,
            "Resources"=>dictionary! {"ExtGState"=>dictionary! {"half"=>dictionary! {"ca"=>0.5}},"XObject"=>dictionary! {"F"=>form}}});
        doc.objects.insert(pages,dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into());let catalog=doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});doc.trailer.set("Root",catalog);
        let cm=color();let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::softproof(),Some(&cm)).unwrap());let matrix=scene.page_to_view(1.,0.,0.);
        let ctx=GpuContext::new_sync().unwrap();let renderer=RetainedRenderer::new(&ctx,scene,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
        let target=ctx.create_target_texture(100,100,wgpu::TextureFormat::Rgba8Unorm,None);renderer.render(&ctx,&target.create_view(&Default::default()),100,100,matrix).unwrap();
        let got=ctx.readback_texture_rgba8(&target,100,100).unwrap();
        let cpu=render_page_managed(&doc,1,72.,PageBox::Crop,RenderOptions::softproof(),Some(&cm)).unwrap().buffer.to_srgb(&cm).unwrap();
        for (a,b) in got.chunks_exact(4).zip(cpu.chunks_exact(3)) {for ch in 0..3 {assert!(a[ch].abs_diff(b[ch])<=2,"{a:?} != {b:?}");}}
        renderer.render(&ctx,&target.create_view(&Default::default()),100,100,renderer.scene.page_to_view(0.5,25.,25.)).unwrap();
        let margin=ctx.readback_texture_rgba8(&target,100,100).unwrap();
        assert_eq!(&margin[..4],&[82,86,89,255]);
        assert_ne!(&margin[(50*100+50)*4..(50*100+50)*4+4],&[82,86,89,255]);
    }
    fn color()->ColorManager {ColorManager::from_cmyk_profile(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc"),RenderIntent::RelativeColorimetric).unwrap()}
    #[test]
    #[ignore="R01 local: PRYNX_R01_PDF, PRYNX_R01_OUT"]
    fn r01_scene_render_and_measure() {
        let path=std::env::var("PRYNX_R01_PDF").unwrap();let out=std::path::PathBuf::from(std::env::var("PRYNX_R01_OUT").unwrap());
        let now=std::time::Instant::now();let doc=Document::load(path).unwrap();let cm=color();
        let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(&cm)).unwrap());println!("compile {:?}",now.elapsed());
        let now=std::time::Instant::now();let mut packet=Vec::new();scene.write_wire(1,&mut packet).unwrap();println!("wire encode {:?}, {} bytes",now.elapsed(),packet.len());
        let now=std::time::Instant::now();let mut scene=Arc::new(RetainedPage::read_wire(&packet[..],1,8*1024*1024*1024).unwrap());println!("wire decode {:?}",now.elapsed());drop(packet);
        if let Ok(path)=std::env::var("PRYNX_R01_WORKER_PACKET") {
            scene=Arc::new(RetainedPage::read_wire(std::fs::File::open(path).unwrap(),17,8*1024*1024*1024).unwrap());
            println!("source: native worker packet revision=17");
        }
        let ctx=GpuContext::new_sync().unwrap();println!("adapter {:?}",ctx.adapter_info);let matrix=scene.page_to_view(104./72.,0.,0.);
        let now=std::time::Instant::now();let renderer=RetainedRenderer::new(&ctx,scene.clone(),&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();println!("prepare {:?}",now.elapsed());
        let target=ctx.create_target_texture(1081,811,wgpu::TextureFormat::Rgba8Unorm,None);let view=target.create_view(&Default::default());
        for i in 0..6 {let now=std::time::Instant::now();let stats=renderer.render(&ctx,&view,1081,811,matrix).unwrap();ctx.device.poll(wgpu::Maintain::Wait);println!("frame {i}: {:?}, {stats:?}",now.elapsed());}
        let got=ctx.readback_texture_rgba8(&target,1081,811).unwrap();tiny_skia::Pixmap::from_vec(got.clone(),tiny_skia::IntSize::from_wh(1081,811).unwrap()).unwrap().save_png(out.join("r01-retained-gpu.png")).unwrap();
        let now=std::time::Instant::now();let cpu=render_page_managed(&doc,1,104.,PageBox::Crop,RenderOptions::viewer(),Some(&cm)).unwrap();println!("cpu {:?} {}x{} {:?}",now.elapsed(),cpu.buffer.width(),cpu.buffer.height(),cpu.warnings);
        let rgb=cpu.buffer.to_srgb(&cm).unwrap();let mut rgba=Vec::with_capacity(rgb.len()/3*4);for p in rgb.chunks_exact(3){rgba.extend_from_slice(&[p[0],p[1],p[2],255]);}
        tiny_skia::Pixmap::from_vec(rgba,tiny_skia::IntSize::from_wh(cpu.buffer.width(),cpu.buffer.height()).unwrap()).unwrap().save_png(out.join("r01-ppe-cpu.png")).unwrap();
        if cpu.buffer.width()==1081 && cpu.buffer.height()==811 {
            let total:u64=got.chunks_exact(4).zip(rgb.chunks_exact(3)).map(|(a,b)|(0..3).map(|c|u64::from(a[c].abs_diff(b[c]))).sum::<u64>()).sum();println!("mean RGB error {}",total as f64/rgb.len() as f64);
        }
        // Cùng viewport, camera đổi liên tục cả hai chiều và pan; không parse lại.
        let mut reference=if std::env::var_os("PRYNX_R01_COMPARE_CPU").is_some(){
            let profile=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc");
            let mut session=print_engine::RenderSession::open_with_profile_paths(std::env::var("PRYNX_R01_PDF").unwrap(),Some(&profile),None,RenderIntent::RelativeColorimetric).unwrap();
            session.render_page(1,104.,PageBox::Crop,RenderOptions::viewer()).unwrap();Some(session)
        }else{None};
        let mut trace=String::from("frame,scale,x,y,ready_us,encode_us,draws,culled,cpu_warm_us,mean_rgb_error\n");
        for i in 0..120 {
            let phase=if i<60 {i as f32/59.}else{(119-i) as f32/59.};
            let scale=(104./72.)*4f32.powf(phase);
            let x=-((scene.bounds.width()*scale-1081.)*0.5).max(0.).round();
            let y=-((scene.bounds.height()*scale-811.)*(0.45+0.1*(i as f32*0.15).sin())).max(0.).round();
            let now=std::time::Instant::now();let stats=renderer.render(&ctx,&view,1081,811,scene.page_to_view(scale,x,y)).unwrap();ctx.device.poll(wgpu::Maintain::Wait);
            let ready=now.elapsed().as_micros();let mut cpu_us=0;let mut error=0.;
            if i%4==0 {if let Some(reference)=&mut reference {
                let now=std::time::Instant::now();let cpu=reference.render_page_region(1,scale*72.,PageBox::Crop,RenderOptions::viewer(),Some(print_engine::page::RasterClip{x:(-x) as u32,y:(-y) as u32,width:1081,height:811})).unwrap();
                let rgb=cpu.buffer.to_srgb(&cm).unwrap();cpu_us=now.elapsed().as_micros();
                let gpu=ctx.readback_texture_rgba8(&target,1081,811).unwrap();
                assert_eq!(rgb.len(),1081*811*3);
                let total:u64=gpu.chunks_exact(4).zip(rgb.chunks_exact(3)).map(|(a,b)|(0..3).map(|c|u64::from(a[c].abs_diff(b[c]))).sum::<u64>()).sum();
                error=total as f64/rgb.len() as f64;
                assert!(error<4.,"zoom frame={i}, mean RGB={error}");
            }}
            trace.push_str(&format!("{i},{scale},{x},{y},{ready},{},{},{},{cpu_us},{error}\n",stats.encode_us,stats.draws,stats.culled));
            if i==59 {
                let gpu=ctx.readback_texture_rgba8(&target,1081,811).unwrap();
                tiny_skia::Pixmap::from_vec(gpu,tiny_skia::IntSize::from_wh(1081,811).unwrap()).unwrap().save_png(out.join("r01-gpu-zoom4.png")).unwrap();
            }
        }
        std::fs::write(out.join("r01-retained-camera-trace.csv"),trace).unwrap();
    }
}
