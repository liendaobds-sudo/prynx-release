//! PERF (audit 2026-09-25 §R25.GPU.22): camera compositor không raster lại PDF.
//! Overview phủ toàn trang; detail chỉ thay vùng thực sự có dữ liệu, tránh lỗ trắng.
use crate::{GpuContext,GpuError};
use print_engine::geom::Matrix;
use wgpu::util::DeviceExt;

pub struct ResidentFrame {pub texture:wgpu::Texture,pub matrix:Matrix}
// PERF (audit 2026-09-26 §R35): khi zoom vừa vượt frame hiện có, lớp detail
// cũ vẫn tốt hơn overview. Ngưỡng này chỉ quyết định lớp dùng tạm khi tương
// tác; raster_grid_matches mới chứng minh không phải lấy mẫu lại lưới pixel.
// PERF (audit 2026-09-27 §PPE.DETAIL_ZOOM_RETENTION): Giữ lớp detail độ nét cao
// khi phóng to (hỗ trợ tới 50x zoom) thay vì vứt bỏ và rơi về overview 72 DPI mờ tịt.
pub const MIN_DETAIL_DISPLAY_DENSITY:f32=0.02;
impl ResidentFrame {
    pub fn covers(&self, matrix:Matrix, width:u32, height:u32, density:f32)->bool {
        raster_covers(self.matrix,self.texture.width(),self.texture.height(),matrix,width,height,density)
    }
}
/// PERF (audit 2026-09-25 §R35): kiểm cả mật độ và bốn góc thật của camera;
/// cùng mức zoom không có nghĩa vùng mới đã có pixel nét.
pub fn raster_covers(source:Matrix,sw:u32,sh:u32,target:Matrix,tw:u32,th:u32,density:f32)->bool {
    let Some(inv)=target.invert() else{return false;};let m=inv.then(&source);
    if raster_sample_density(source,target)+0.0001<density{return false;}
    [(0.,0.),(tw as f32,0.),(0.,th as f32),(tw as f32,th as f32)].iter().all(|&(x,y)|{
        let sx=m.a*x+m.c*y+m.e;let sy=m.b*x+m.d*y+m.f;
        sx>=-0.001 && sy>=-0.001 && sx<=sw as f32+0.001 && sy<=sh as f32+0.001
    })
}
/// Số pixel của raster nguồn trên một pixel camera. Giá trị dưới 1 buộc
/// phải refine lại; giá trị lớn hơn 1 có thể thu nhỏ bằng filter mà không mờ.
pub fn raster_sample_density(source:Matrix,target:Matrix)->f32 {
    let Some(inv)=target.invert() else{return 0.};let m=inv.then(&source);
    m.a.hypot(m.b).min(m.c.hypot(m.d))
}
/// PERF (audit 2026-09-27 §V27.R8): cùng mật độ chưa đủ để coi là đã nét.
/// Chỉ cùng biến đổi tuyến tính và lệch đúng số pixel nguyên mới giữ lưới
/// raster hiện hành; không nới epsilon để nhận ảnh đã bilinear thành proof.
pub fn raster_grid_matches(source:Matrix,target:Matrix)->bool {
    if ![source.a,source.b,source.c,source.d,source.e,source.f,
        target.a,target.b,target.c,target.d,target.e,target.f].iter().all(|v|v.is_finite()) {
        return false;
    }
    if (source.a,source.b,source.c,source.d)!=(target.a,target.b,target.c,target.d) {
        return false;
    }
    let determinant=source.a as f64*source.d as f64-source.b as f64*source.c as f64;
    if determinant==0. {return false;}
    let dx=source.e as f64-target.e as f64;
    let dy=source.f as f64-target.f as f64;
    dx.fract()==0. && dy.fract()==0.
}
// Phủ toàn viewport bằng tọa độ pixel nguyên, không dùng bbox/epsilon từ
// phép nghịch đảo f32. Chỉ dùng để bỏ các draw chắc chắn đã bị lớp sau che.
fn current_grid_covers(source:Matrix,sw:u32,sh:u32,target:Matrix,width:u32,height:u32)->bool {
    if width==u32::MAX || height==u32::MAX || width==0 || height==0
        || !raster_grid_matches(source,target) {return false;}
    let dx=source.e as f64-target.e as f64;
    let dy=source.f as f64-target.f as f64;
    dx>=0. && dy>=0. && dx+width as f64<=sw as f64 && dy+height as f64<=sh as f64
}
fn ordered_detail_layers<'a>(details:&[&'a ResidentFrame],matrix:Matrix,width:u32,height:u32)->Vec<&'a ResidentFrame> {
    let density=|f:&ResidentFrame|raster_sample_density(f.matrix,matrix);
    let mut layers:Vec<_>=details.iter().copied().filter(|d| {
        // encode() cũ không truyền kích thước camera; không dùng u32::MAX
        // làm hình học thật và không áp loại lớp bị che trong trường hợp đó.
        let intersects=width==u32::MAX || height==u32::MAX
            || raster_overlaps(d.matrix,d.texture.width(),d.texture.height(),matrix,width,height);
        intersects && density(d)>=MIN_DETAIL_DISPLAY_DENSITY
    }).collect();
    layers.sort_by(|a,b|match (raster_grid_matches(a.matrix,matrix),raster_grid_matches(b.matrix,matrix)) {
        (false,false)=>density(a).total_cmp(&density(b)),
        (true,true)=>std::cmp::Ordering::Equal,
        (a,b)=>a.cmp(&b),
    });
    // sort_by ổn định: cùng lưới giữ entry mới ở trên. Một full-detail đúng
    // lưới che toàn bộ lớp thấp hơn; giữ cache để dùng lại, chỉ bỏ draw thừa.
    if let Some(first)=layers.iter().rposition(|f|current_grid_covers(f.matrix,f.texture.width(),f.texture.height(),matrix,width,height)) {
        layers.drain(..first);
    }
    layers
}
/// Kiểm tra hai vùng raster/camera có giao nhau để chỉ chồng lớp detail hữu ích.
pub fn raster_overlaps(source:Matrix,sw:u32,sh:u32,target:Matrix,tw:u32,th:u32)->bool {
    let Some(inv)=target.invert() else{return false;};let m=inv.then(&source);
    let points=[(0.,0.),(tw as f32,0.),(0.,th as f32),(tw as f32,th as f32)];
    let min_x=points.iter().map(|&(x,y)|m.a*x+m.c*y+m.e).fold(f32::INFINITY,f32::min);
    let max_x=points.iter().map(|&(x,y)|m.a*x+m.c*y+m.e).fold(f32::NEG_INFINITY,f32::max);
    let min_y=points.iter().map(|&(x,y)|m.b*x+m.d*y+m.f).fold(f32::INFINITY,f32::min);
    let max_y=points.iter().map(|&(x,y)|m.b*x+m.d*y+m.f).fold(f32::NEG_INFINITY,f32::max);
    max_x>=0. && max_y>=0. && min_x<=sw as f32 && min_y<=sh as f32
}
// PERF (audit 2026-09-27 §V27.R3): mảnh detail nhỏ không quét shader trên cả
// viewport. Đảo đúng map f32 gửi shader bằng f64, mở biên bảo thủ theo sai số
// lấy mẫu; scissor chỉ giảm fragment, không đổi UV/filter/thứ tự compositing.
fn detail_scissor(source:Matrix,sw:u32,sh:u32,target:Matrix,width:u32,height:u32)->[u32;4]{
    let full=[0,0,width,height];
    let Some(inv)=target.invert() else{return full;};let m=inv.then(&source);
    let (a,b,c,d,e,f)=(m.a as f64,m.b as f64,m.c as f64,m.d as f64,m.e as f64,m.f as f64);
    let det=a*d-b*c;if !det.is_finite() || det.abs()<1e-12{return full;}
    let ps=[(0.,0.),(sw as f64,0.),(0.,sh as f64),(sw as f64,sh as f64)].map(|(x,y)|((d*(x-e)-c*(y-f))/det,(-b*(x-e)+a*(y-f))/det));
    if !ps.iter().all(|(x,y)|x.is_finite() && y.is_finite()){return full;}
    let error=8.*f32::EPSILON as f64*((a.abs()+b.abs())*width as f64+(c.abs()+d.abs())*height as f64+e.abs()+f.abs()+1.);
    let pad=2.+error*(a.abs()+b.abs()+c.abs()+d.abs())/det.abs();
    let x=(ps.iter().map(|p|p.0).fold(f64::INFINITY,f64::min)-pad).floor().clamp(0.,width as f64)as u32;
    let y=(ps.iter().map(|p|p.1).fold(f64::INFINITY,f64::min)-pad).floor().clamp(0.,height as f64)as u32;
    let right=(ps.iter().map(|p|p.0).fold(f64::NEG_INFINITY,f64::max)+pad).ceil().clamp(x as f64,width as f64)as u32;
    let bottom=(ps.iter().map(|p|p.1).fold(f64::NEG_INFINITY,f64::max)+pad).ceil().clamp(y as f64,height as f64)as u32;
    [x,y,right-x,bottom-y]
}
pub struct ResidentCompositor {pipeline:wgpu::RenderPipeline,layout:wgpu::BindGroupLayout,sampler:wgpu::Sampler,srgb:bool}
#[repr(C)]
#[derive(Clone,Copy,bytemuck::Pod,bytemuck::Zeroable)]
struct Params {overview0:[f32;4],overview1:[f32;4],detail0:[f32;4],detail1:[f32;4],flags:[u32;4]}
impl ResidentCompositor {
    pub fn new(ctx:&GpuContext,format:wgpu::TextureFormat)->Self {
        let texture=|binding|wgpu::BindGroupLayoutEntry{binding,visibility:wgpu::ShaderStages::FRAGMENT,
            ty:wgpu::BindingType::Texture{sample_type:wgpu::TextureSampleType::Float{filterable:true},view_dimension:wgpu::TextureViewDimension::D2,multisampled:false},count:None};
        let layout=ctx.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor{label:Some("PPE resident camera"),entries:&[
            texture(0),texture(1),wgpu::BindGroupLayoutEntry{binding:2,visibility:wgpu::ShaderStages::FRAGMENT,ty:wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),count:None},
            wgpu::BindGroupLayoutEntry{binding:3,visibility:wgpu::ShaderStages::FRAGMENT,ty:wgpu::BindingType::Buffer{ty:wgpu::BufferBindingType::Uniform,has_dynamic_offset:false,min_binding_size:None},count:None}]});
        let shader=ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor{label:Some("PPE resident camera"),source:wgpu::ShaderSource::Wgsl(SHADER.into())});
        let pl=ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor{label:None,bind_group_layouts:&[&layout],push_constant_ranges:&[]});
        let pipeline=ctx.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor{label:None,layout:Some(&pl),
            vertex:wgpu::VertexState{module:&shader,entry_point:Some("vs"),buffers:&[],compilation_options:Default::default()},
            fragment:Some(wgpu::FragmentState{module:&shader,entry_point:Some("fs"),targets:&[Some(wgpu::ColorTargetState{format,blend:None,write_mask:wgpu::ColorWrites::ALL})],compilation_options:Default::default()}),
            primitive:Default::default(),depth_stencil:None,multisample:Default::default(),multiview:None,cache:None});
        let sampler=ctx.device.create_sampler(&wgpu::SamplerDescriptor{mag_filter:wgpu::FilterMode::Linear,min_filter:wgpu::FilterMode::Linear,..Default::default()});
        Self{pipeline,layout,sampler,srgb:format.is_srgb()}
    }
    pub fn encode(&self,ctx:&GpuContext,e:&mut wgpu::CommandEncoder,output:&wgpu::TextureView,matrix:Matrix,
        overview:&ResidentFrame,detail:Option<&ResidentFrame>)->Result<(),GpuError>{
        let density=|d:&ResidentFrame|raster_sample_density(d.matrix,matrix);
        let layers:Vec<_>=detail.into_iter().filter(|d|density(d)>=MIN_DETAIL_DISPLAY_DENSITY).collect();
        self.encode_layers(ctx,e,output,matrix,overview,&layers,u32::MAX,u32::MAX)
    }
    /// Giữ lớp dự trữ khi khung tương tác mới chỉ phủ một phần của nó.
    /// Lớp lấy mẫu lại vẽ từ thưa tới dày, sau đó mới đến raster đúng lưới
    /// camera; ảnh mật độ cao cũ không được đè raster mới đã nét thực sự.
    pub fn encode_layers(&self,ctx:&GpuContext,e:&mut wgpu::CommandEncoder,output:&wgpu::TextureView,matrix:Matrix,
        overview:&ResidentFrame,details:&[&ResidentFrame],width:u32,height:u32)->Result<(),GpuError>{
        let layers=ordered_detail_layers(details,matrix,width,height);
        self.encode_layer(ctx,e,output,matrix,overview,None,false,None)?;
        for layer in layers {
            let scissor=if width==u32::MAX || height==u32::MAX{None}else{Some(detail_scissor(layer.matrix,layer.texture.width(),layer.texture.height(),matrix,width,height))};
            if scissor.is_some_and(|r|r[2]==0 || r[3]==0){continue;}
            self.encode_layer(ctx,e,output,matrix,overview,Some(layer),true,scissor)?;
        }
        Ok(())
    }
    fn encode_layer(&self,ctx:&GpuContext,e:&mut wgpu::CommandEncoder,output:&wgpu::TextureView,matrix:Matrix,
        overview:&ResidentFrame,detail:Option<&ResidentFrame>,overlay:bool,scissor:Option<[u32;4]>)->Result<(),GpuError>{
        let inv=matrix.invert().ok_or_else(||GpuError::UnsupportedPass("Camera resident suy biến".into()))?;
        let detail=detail;
        let map=|frame:&ResidentFrame|{
            // PERF (audit 2026-09-27 §V27.R8): đã chứng minh cùng lưới thì
            // dùng thẳng offset nguyên. Invert/nhân f32 ở pan lớn tạo sai số
            // dưới pixel, làm texture nét bị bilinear lại ngay trên chính nó.
            let m=if raster_grid_matches(frame.matrix,matrix) {
                Matrix::translate((frame.matrix.e as f64-matrix.e as f64)as f32,
                    (frame.matrix.f as f64-matrix.f as f64)as f32)
            }else{inv.then(&frame.matrix)};
            ([m.a,m.b,m.c,m.d],[m.e,m.f,frame.texture.width() as f32,frame.texture.height() as f32])
        };
        let (overview0,overview1)=map(overview);let (detail0,detail1)=map(detail.unwrap_or(overview));
        let params=Params{overview0,overview1,detail0,detail1,flags:[detail.is_some() as u32,self.srgb as u32,overlay as u32,0]};
        let uniform=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor{label:None,contents:bytemuck::bytes_of(&params),usage:wgpu::BufferUsages::UNIFORM});
        let base=overview.texture.create_view(&Default::default());let fine=detail.unwrap_or(overview).texture.create_view(&Default::default());
        let bind=ctx.device.create_bind_group(&wgpu::BindGroupDescriptor{label:None,layout:&self.layout,entries:&[
            wgpu::BindGroupEntry{binding:0,resource:wgpu::BindingResource::TextureView(&base)},wgpu::BindGroupEntry{binding:1,resource:wgpu::BindingResource::TextureView(&fine)},
            wgpu::BindGroupEntry{binding:2,resource:wgpu::BindingResource::Sampler(&self.sampler)},wgpu::BindGroupEntry{binding:3,resource:uniform.as_entire_binding()}]});
        let mut pass=e.begin_render_pass(&wgpu::RenderPassDescriptor{label:Some("PPE camera resident"),color_attachments:&[Some(wgpu::RenderPassColorAttachment{
            view:output,resolve_target:None,ops:wgpu::Operations{load:if overlay{wgpu::LoadOp::Load}else{wgpu::LoadOp::Clear(wgpu::Color::BLACK)},store:wgpu::StoreOp::Store}})],depth_stencil_attachment:None,timestamp_writes:None,occlusion_query_set:None});
        pass.set_pipeline(&self.pipeline);pass.set_bind_group(0,&bind,&[]);
        if let Some([x,y,w,h])=scissor{pass.set_scissor_rect(x,y,w,h);}
        pass.draw(0..3,0..1);Ok(())
    }
}
const SHADER:&str=r#"
struct Params {b0:vec4f,b1:vec4f,d0:vec4f,d1:vec4f,flags:vec4u}
@group(0) @binding(0) var base:texture_2d<f32>;
@group(0) @binding(1) var fine:texture_2d<f32>;
@group(0) @binding(2) var filtering:sampler;
@group(0) @binding(3) var<uniform> p:Params;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
    let points=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));return vec4f(points[i],0.,1.);
}
fn coords(x:vec2f,m:vec4f,t:vec4f)->vec2f{return vec2f(m.x*x.x+m.z*x.y+t.x,m.y*x.x+m.w*x.y+t.y);}
fn inside(x:vec2f,size:vec2f)->bool{return all(x>=vec2f(0.)) && all(x<size);}
@fragment fn fs(@builtin(position) xy:vec4f)->@location(0) vec4f {
    let b=coords(xy.xy,p.b0,p.b1);let d=coords(xy.xy,p.d0,p.d1);
    // Lấy mẫu vô điều kiện giữ gradient hợp lệ ở biên nhánh fragment.
    let coarse=textureSampleLevel(base,filtering,b/p.b1.zw,0.);
    let sharp=textureSampleLevel(fine,filtering,d/p.d1.zw,0.);
    if p.flags.z!=0u && (!inside(b,p.b1.zw) || !inside(d,p.d1.zw)) {discard;}
    if !inside(b,p.b1.zw) {
        var grey=vec3f(82.,86.,89.)/255.;
        if p.flags.y!=0u {grey=select(grey/12.92,pow((grey+0.055)/1.055,vec3f(2.4)),grey>vec3f(0.04045));}
        return vec4f(grey,1.);
    }
    if p.flags.x!=0u && inside(d,p.d1.zw) {return sharp;}
    return coarse;
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_grid_requires_equal_linear_part_and_integer_pixel_offset(){
        for target in [Matrix::IDENTITY,Matrix::new(1.25,0.,0.,-1.25,0.375,98.625),
            Matrix::new(0.,1.5,-1.5,0.,128.25,-0.75),Matrix::new(1.,0.25,0.5,1.,0.5,0.25)] {
            assert!(raster_grid_matches(target,target));
            assert!(raster_grid_matches(Matrix{e:target.e+17.,f:target.f-9.,..target},target));
            assert!(!raster_grid_matches(Matrix{e:target.e+0.25,..target},target));
            assert!(!raster_grid_matches(Matrix{f:target.f-0.5,..target},target));
        }
        let target=Matrix::IDENTITY;
        assert!(!raster_grid_matches(Matrix{a:f32::from_bits(1f32.to_bits()+1),..target},target));
        assert!(!raster_grid_matches(Matrix{e:f32::EPSILON,..target},target));
        assert!(!raster_grid_matches(Matrix::scale(2.,2.),target));
        for invalid in [Matrix::scale(0.,1.),Matrix::new(1.,2.,2.,4.,0.,0.),
            Matrix{e:f32::INFINITY,..target},Matrix{a:f32::NAN,..target}] {
            assert!(!raster_grid_matches(invalid,invalid));
            assert!(!raster_grid_matches(invalid,target));
        }
    }
    #[test]
    fn whole_view_occlusion_uses_exact_integer_extent(){
        let target=Matrix::new(1.25,0.,0.,-1.25,0.375,100.625);
        let covering=Matrix{e:target.e+4.,f:target.f+6.,..target};
        assert!(current_grid_covers(covering,132,102,target,128,96));
        assert!(!current_grid_covers(covering,131,102,target,128,96));
        assert!(!current_grid_covers(covering,132,101,target,128,96));
        assert!(!current_grid_covers(Matrix{e:target.e-1.,..target},256,192,target,128,96));
        assert!(!current_grid_covers(Matrix{e:target.e+0.25,..target},256,192,target,128,96));
        assert!(!current_grid_covers(target,128,96,target,u32::MAX,u32::MAX));
    }
    #[test]
    fn newest_full_current_grid_omits_only_lower_occluded_layers(){
        let ctx=GpuContext::new_sync().unwrap();let target=Matrix::IDENTITY;
        let frame=|w,h,matrix|ResidentFrame{texture:ctx.create_target_texture(w,h,wgpu::TextureFormat::Rgba8Unorm,None),matrix};
        let old_dense=frame(256,192,Matrix::scale(2.,2.));
        let old_exact=frame(128,96,target);
        let new_exact=frame(132,102,Matrix::translate(4.,6.));
        let newest_partial=frame(32,24,Matrix::translate(-16.,-12.));
        let layers=ordered_detail_layers(&[&old_exact,&old_dense,&new_exact,&newest_partial],target,128,96);
        assert_eq!(layers.len(),2,"Không encode lại detail đã bị full-frame đúng lưới che kín");
        assert!(std::ptr::eq(layers[0],&new_exact));
        assert!(std::ptr::eq(layers[1],&newest_partial),"ROI mới hơn vẫn nằm trên full-frame");
        let left=frame(64,96,target);let right=frame(64,96,Matrix::translate(-64.,0.));
        let partials=ordered_detail_layers(&[&left,&old_dense,&right],target,128,96);
        assert_eq!(partials.len(),3,"Không coi một crop là full-frame để bỏ lớp dự phòng");
        assert!(std::ptr::eq(partials[0],&old_dense));
        assert!(std::ptr::eq(partials[1],&left));assert!(std::ptr::eq(partials[2],&right));
    }
    #[test]
    fn tiny_detail_scissor_does_not_cover_the_whole_viewport(){
        let rect=detail_scissor(Matrix::translate(-600.,-400.),3,5,Matrix::IDENTITY,1292,733);
        assert!(rect[2]*rect[3]<150,"Scissor phải gần vùng 15 pixel, không quét toàn màn: {rect:?}");
        assert!(rect[0]<=600 && rect[1]<=400 && rect[0]+rect[2]>=603 && rect[1]+rect[3]>=405);
    }
    #[test]
    fn scissored_layers_match_fullscreen_at_fractional_camera_and_rotation(){
        let ctx=GpuContext::new_sync().unwrap();let format=wgpu::TextureFormat::Rgba8Unorm;
        let make=|width,height,seed:u8,matrix|{
            let texture=ctx.create_target_texture(width,height,format,None);
            let pixels:Vec<u8>=(0..width*height).flat_map(|i|[seed.wrapping_add(i as u8),seed.wrapping_add((i/width)as u8),91,255]).collect();
            ctx.queue.write_texture(wgpu::TexelCopyTextureInfo{texture:&texture,mip_level:0,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},&pixels,wgpu::TexelCopyBufferLayout{offset:0,bytes_per_row:Some(width*4),rows_per_image:Some(height)},wgpu::Extent3d{width,height,depth_or_array_layers:1});
            ResidentFrame{texture,matrix}
        };
        let base=make(128,96,11,Matrix::IDENTITY);
        let layers:Vec<_>=(0..123).map(|i|make(3+(i%7),5+(i%11),i as u8,Matrix::new(1.5,0.,0.,1.5,-(((i*17)%190)as f32)+0.125,-(((i*13)%143)as f32)-0.75))).collect();
        let refs:Vec<_>=layers.iter().collect();let compositor=ResidentCompositor::new(&ctx,format);
        for matrix in [Matrix::IDENTITY,Matrix::new(1.25,0.,0.,1.25,-5.35,3.75),Matrix::new(0.,1.,-1.,0.,100.125,-0.75),Matrix::new(0.77,0.1,0.2,1.1,1.25,-2.75)] {
            let target=ctx.create_target_texture(128,96,format,None);let reference=ctx.create_target_texture(128,96,format,None);
            let mut e=ctx.device.create_command_encoder(&Default::default());
            compositor.encode_layers(&ctx,&mut e,&target.create_view(&Default::default()),matrix,&base,&refs,128,96).unwrap();
            let view=reference.create_view(&Default::default());
            compositor.encode_layer(&ctx,&mut e,&view,matrix,&base,None,false,None).unwrap();
            let mut ordered:Vec<_>=refs.iter().copied().filter(|d|raster_sample_density(d.matrix,matrix)>=MIN_DETAIL_DISPLAY_DENSITY && raster_overlaps(d.matrix,d.texture.width(),d.texture.height(),matrix,128,96)).collect();
            ordered.sort_by(|a,b|raster_sample_density(a.matrix,matrix).total_cmp(&raster_sample_density(b.matrix,matrix)));
            for layer in ordered{compositor.encode_layer(&ctx,&mut e,&view,matrix,&base,Some(layer),true,None).unwrap();}
            ctx.queue.submit([e.finish()]);
            assert_eq!(ctx.readback_texture_rgba8(&target,128,96).unwrap(),ctx.readback_texture_rgba8(&reference,128,96).unwrap(),"Scissor không được đổi pixel camera={matrix:?}");
        }
    }
    #[test]
    fn raster_cover_rejects_partial_or_low_density_detail() {
        let full=Matrix::IDENTITY;
        assert!(raster_covers(full,100,100,full,100,100,1.));
        assert!(!raster_covers(Matrix::new(1.,0.,0.,1.,-50.,0.),100,100,full,100,100,1.));
        assert!(!raster_covers(Matrix::new(0.5,0.,0.,0.5,0.,0.),100,100,full,100,100,1.));
        assert!((raster_sample_density(Matrix::new(0.5,0.,0.,0.5,0.,0.),full)-0.5).abs()<0.001);
        assert!(raster_overlaps(Matrix::new(1.,0.,0.,1.,-50.,0.),100,100,full,100,100));
        assert!(!raster_overlaps(Matrix::new(1.,0.,0.,1.,-101.,0.),100,100,full,100,100));
    }
    #[test]
    fn display_keeps_detail_through_one_wheel_zoom_step() {
        let density=1.0/1.15;
        assert!(density>=MIN_DETAIL_DISPLAY_DENSITY);
        assert!(density<0.9,"ngưỡng refine phải cao hơn ngưỡng hiển thị");
    }
    #[test]
    fn reverse_zoom_reveals_overview_without_white_holes_or_old_pan() {
        let ctx=GpuContext::new_sync().unwrap();let format=wgpu::TextureFormat::Rgba8Unorm;
        let solid=|w,h,color:[u8;4]|{let t=ctx.create_target_texture(w,h,format,None);let data=color.repeat((w*h) as usize);
            ctx.queue.write_texture(wgpu::TexelCopyTextureInfo{texture:&t,mip_level:0,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},&data,
                wgpu::TexelCopyBufferLayout{offset:0,bytes_per_row:Some(w*4),rows_per_image:Some(h)},wgpu::Extent3d{width:w,height:h,depth_or_array_layers:1});t};
        let overview=ResidentFrame{texture:solid(100,100,[10,90,180,255]),matrix:Matrix::IDENTITY};
        let detail=ResidentFrame{texture:solid(100,100,[200,30,60,255]),matrix:Matrix::new(2.,0.,0.,2.,-50.,-50.)};
        let out=ctx.create_target_texture(100,100,format,None);let compositor=ResidentCompositor::new(&ctx,format);
        for (matrix,points) in [
            (Matrix::IDENTITY,vec![(10,10,[10,90,180,255]),(50,50,[200,30,60,255]),(90,90,[10,90,180,255])]),
            (Matrix::new(0.5,0.,0.,0.5,25.,25.),vec![(10,10,[82,86,89,255]),(30,30,[10,90,180,255]),(50,50,[200,30,60,255])]),
            (Matrix::translate(-40.,0.),vec![(10,50,[200,30,60,255]),(90,50,[82,86,89,255])])]{
            let mut e=ctx.device.create_command_encoder(&Default::default());compositor.encode(&ctx,&mut e,&out.create_view(&Default::default()),matrix,&overview,Some(&detail)).unwrap();ctx.queue.submit([e.finish()]);
            let pixels=ctx.readback_texture_rgba8(&out,100,100).unwrap();for (x,y,expected) in points {assert_eq!(&pixels[(y*100+x)*4..(y*100+x)*4+4],&expected);}
        }
    }
}
