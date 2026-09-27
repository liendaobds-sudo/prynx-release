//! Resource màu đã giải mã được upload một lần, camera chỉ đổi ma trận lấy mẫu.
use std::sync::Arc;
use rayon::prelude::*;
use crate::{GpuContext,GpuError,ink_surface::InkSurface};
use print_engine::{color::icc::ColorManager,error::RenderWarnings,geom::Matrix,
    image::sampler::{SampledImage,ImageSampler},ink::{InkSpace,ChannelMask},shading::{Shading,ShadingKind}};
use wgpu::util::DeviceExt;

pub struct Material {
    pub texture:wgpu::Texture,
    pub view:wgpu::TextureView,
    pub declared:ChannelMask,
    pub size:[u32;2],
    pub kind:u32,
    pub coordinates:[f32;8],
    pub extend:[u32;2],
    pub stencil:bool,
    pub bbox:Option<print_engine::geom::Rect>,
}

fn err(e:impl std::fmt::Display)->GpuError {GpuError::UnsupportedPass(e.to_string())}
fn layers(n:usize)->u32 {(n+1).div_ceil(4) as u32}
fn upload(ctx:&GpuContext,w:u32,h:u32,n:usize,values:Vec<half::f16>,mipmaps:bool)->Result<wgpu::Texture,GpuError> {
    if w==0 || h==0 || w>ctx.device.limits().max_texture_dimension_2d || h>ctx.device.limits().max_texture_dimension_2d {
        return Err(err("Ảnh vượt kích thước texture; cần chia resource theo tile"));
    }
    let levels=if mipmaps {32-w.max(h).leading_zeros()} else {1};
    let texture=ctx.device.create_texture(&wgpu::TextureDescriptor {label:Some("PPE retained ink resource"),
        size:wgpu::Extent3d {width:w,height:h,depth_or_array_layers:layers(n)},mip_level_count:levels,sample_count:1,
        dimension:wgpu::TextureDimension::D2,format:wgpu::TextureFormat::Rgba16Float,
        usage:wgpu::TextureUsages::TEXTURE_BINDING|wgpu::TextureUsages::COPY_DST,view_formats:&[]});
    let mut data=values;let(mut width,mut height)=(w,h);
    for level in 0..levels {
        if !ctx.upload_probe_enabled(){
            // Đường sản phẩm giữ upload nhanh đã đo; probe tường minh bên
            // dưới chỉ để tách GPU copy, không áp overhead cho mọi lần mở.
            ctx.queue.write_texture(wgpu::TexelCopyTextureInfo{texture:&texture,mip_level:level,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},
                bytemuck::cast_slice(&data),wgpu::TexelCopyBufferLayout{offset:0,bytes_per_row:Some(width*8),rows_per_image:Some(height)},wgpu::Extent3d{width,height,depth_or_array_layers:layers(n)});
        }else{
        // PERF (audit 2026-09-27 §V27.B3): staging tường minh để đo đúng GPU
        // copy, và upload ảnh trước có thể chạy khi CPU chuẩn bị ảnh sau.
        // Không đổi f16/mipmap/màu; chỉ thêm padding theo hàng cho copy buffer.
        let row_bytes=width*8;let stride=row_bytes.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)*wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let upload=ctx.device.create_buffer(&wgpu::BufferDescriptor{label:Some("PPE material staging"),size:u64::from(stride)*u64::from(height)*u64::from(layers(n)),usage:wgpu::BufferUsages::COPY_SRC,mapped_at_creation:true});
        {
            let mut mapped=upload.slice(..).get_mapped_range_mut();let bytes:&[u8]=bytemuck::cast_slice(&data);
            for(row,source)in bytes.chunks_exact(row_bytes as usize).enumerate(){let start=row*stride as usize;mapped[start..start+row_bytes as usize].copy_from_slice(source);}
        }
        upload.unmap();let mut copy=ctx.device.create_command_encoder(&Default::default());
        copy.copy_buffer_to_texture(wgpu::TexelCopyBufferInfo{buffer:&upload,layout:wgpu::TexelCopyBufferLayout{offset:0,bytes_per_row:Some(stride),rows_per_image:Some(height)}},
            wgpu::TexelCopyTextureInfo{texture:&texture,mip_level:level,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},wgpu::Extent3d{width,height,depth_or_array_layers:layers(n)});
        ctx.submit_stage(format!("material-upload width={width} height={height} layers={}",layers(n)),[copy.finish()]);
        }
        if level+1==levels {break;}
        let nw=(width/2).max(1);let nh=(height/2).max(1);
        let mut next=vec![half::f16::ZERO;nw as usize*nh as usize*layers(n) as usize*4];
        // PERF (audit 2026-09-25 §R25.GPU.31): mỗi hàng độc lập, giữ thứ tự cộng
        // từng texel như bản tuần tự để không đổi màu/mipmap ở cạnh kích thước lẻ.
        next.par_chunks_mut(nw as usize*4).enumerate().for_each(|(row,values)| {
            let layer=row/nh as usize;let y=(row%nh as usize) as u32;
            for x in 0..nw {
                let x0=x*width/nw;let x1=(x+1)*width/nw;let y0=y*height/nh;let y1=(y+1)*height/nh;
                for ch in 0..4 {let mut sum=0.0;for sy in y0..y1 {for sx in x0..x1 {
                    sum+=data[((layer*height as usize+sy as usize)*width as usize+sx as usize)*4+ch].to_f32();
                }}values[x as usize*4+ch]=half::f16::from_f32(sum/((x1-x0)*(y1-y0)) as f32);}
            }
        });
        data=next;width=nw;height=nh;
    }
    Ok(texture)
}

impl Material {
    pub fn image(ctx:&GpuContext,image:&Arc<SampledImage>,space:&mut InkSpace,cm:&ColorManager)->Result<Self,GpuError> {
        Self::image_cancellable(ctx,image,space,cm,&||false)
    }
    pub fn image_cancellable(ctx:&GpuContext,image:&Arc<SampledImage>,space:&mut InkSpace,cm:&ColorManager,cancel:&(dyn Fn()->bool+Sync))->Result<Self,GpuError> {
        if cancel(){return Err(err("Frame đã bị thay thế"));}
        if image.width==0 || image.height==0 || image.width>ctx.device.limits().max_texture_dimension_2d || image.height>ctx.device.limits().max_texture_dimension_2d {
            return Err(err("Ảnh vượt kích thước texture; cần chia resource theo tile"));
        }
        let mut warnings=RenderWarnings::default();let sampler=ImageSampler::new(image,space,&mut warnings,Some(cm)).map_err(err)?;
        let n=space.len();let pixels=image.width as usize*image.height as usize;
        let mut data=vec![half::f16::ZERO;pixels*layers(n) as usize*4];
        // Không chia sẻ handle LCMS giữa luồng. Sampler/LUT chỉ đọc; mỗi tác vụ
        // có ColorManager, InkSpace và warning riêng, ghi vào lát bộ nhớ rời nhau.
        // Số tác vụ theo số luồng Rayon (tôn trọng RAYON_NUM_THREADS), không hard-cap.
        let rows=(image.height as usize).div_ceil(rayon::current_num_threads()).max(1);
        let chunk=rows*image.width as usize*4;
        let count=(image.height as usize).div_ceil(rows);
        let mut bands:Vec<Vec<&mut [half::f16]>>=(0..count).map(|_|Vec::new()).collect();
        for plane in data.chunks_mut(pixels*4) {for (i,band) in plane.chunks_mut(chunk).enumerate(){bands[i].push(band);}}
        let jobs=bands.into_iter().map(|planes|Ok((planes,space.clone(),cm.fork_for_render().map_err(err)?)))
            .collect::<Result<Vec<_>,GpuError>>()?;
        let masks=jobs.into_par_iter().enumerate().map(|(band,(mut planes,mut local_space,local_color))| {
            let mut local_warnings=RenderWarnings::default();let mut ink=Vec::new();let mut declared=ChannelMask::EMPTY;
            let start_y=band*rows;let count=planes[0].len()/4;
            for at in 0..count {
                // PERF (audit 2026-09-27 §V27.F): checkpoint ảnh lớn, không
                // phải cap độ phân giải hay số worker trên máy mạnh.
                if at & 4095 == 0 && cancel(){return Err(err("Frame đã bị thay thế"));}
                let x=(at%image.width as usize) as u32;let y=(start_y+at/image.width as usize) as u32;
                let alpha=if image.stencil.is_some(){if image.stencil_at(x,y){1.0}else{0.0}}else{image.alpha_at(x,y)};
                let participates=if image.stencil.is_some(){true}else{
                    let mask=sampler.ink_into(x,y,&mut ink,&mut local_space,&mut local_warnings,Some(&local_color)).map_err(err)?;
                    if let Some(mask)=mask{declared=declared.union(mask);true}else{false}
                };
                let alpha=if participates{alpha}else{0.0};
                for ch in 0..=n {let value=if ch==n{alpha}else{ink.get(ch).copied().unwrap_or(0.0)*alpha};
                    planes[ch/4][at*4+ch%4]=half::f16::from_f32(value);}
            }
            if local_space.len()!=n || local_warnings.dropped_objects>0 || !local_warnings.approximated_colorspaces.is_empty(){
                return Err(err("Ảnh thay đổi InkSpace hoặc cần color fallback"));
            }
            Ok(declared)
        }).collect::<Result<Vec<_>,GpuError>>()?;
        let declared=masks.into_iter().fold(ChannelMask::EMPTY,|a,b|a.union(b));
        if space.len()!=n || warnings.dropped_objects>0 || !warnings.approximated_colorspaces.is_empty() {
            return Err(err("Ảnh thay đổi InkSpace hoặc cần color fallback"));
        }
        // PERF (fix 2026-09-27): Không tạo 12 cấp mipmap bằng CPU f16 tốn 9s cho ảnh lớn.
        // Prepress viewer zoom/fit lấy mẫu bilinear trực tiếp trên GPU từ mức 0 trong <50ms.
        if cancel(){return Err(err("Frame đã bị thay thế"));}
        let texture=upload(ctx,image.width,image.height,n,data,false)?;let view=texture.create_view(&Default::default());
        Ok(Self{texture,view,declared,size:[image.width,image.height],kind:0,coordinates:[0.;8],extend:[0;2],stencil:image.stencil.is_some(),bbox:None})
    }
    pub fn shading(ctx:&GpuContext,shading:&Shading,space:&mut InkSpace,cm:&ColorManager)->Result<Self,GpuError> {
        let (kind,coordinates,domain,extend)=match &shading.kind {
            ShadingKind::Axial{coords,domain,extend}=>(1,[coords[0],coords[1],coords[2],coords[3],0.,0.,0.,0.],*domain,*extend),
            ShadingKind::Radial{coords,domain,extend}=>(2,[coords[0],coords[1],coords[2],coords[3],coords[4],coords[5],0.,0.],*domain,*extend),
            _=>return Err(err("Shading Function/Mesh cần PPE dependency replay")),
        };
        let mut values=Vec::new();let mut declared=ChannelMask::EMPTY;let mut warnings=RenderWarnings::default();
        for i in 0..256 {let t=domain[0]+(domain[1]-domain[0])*i as f32/255.;
            let components=shading.function.as_ref().ok_or_else(||err("Shading thiếu Function"))?.eval(&[t]);
            let value=shading.colorspace.to_ink(&components,space,&mut warnings,Some(cm)).map_err(err)?;
            if let Some((_,mask))=&value {declared=declared.union(*mask);}values.push(value);
        }
        let n=space.len();let mut data=vec![half::f16::ZERO;256*layers(n) as usize*4];
        for (i,value) in values.iter().enumerate() {for ch in 0..=n {let v=match value {Some((ink,_))=>if ch==n{1.0}else{ink.get(ch).copied().unwrap_or(0.0)},None=>0.0};
            data[(ch/4*256+i)*4+ch%4]=half::f16::from_f32(v);}}
        let texture=upload(ctx,256,1,n,data,false)?;let view=texture.create_view(&Default::default());
        Ok(Self{texture,view,declared,size:[256,1],kind,coordinates,extend:[extend[0] as u32,extend[1] as u32],stencil:false,bbox:shading.bbox})
    }
}

#[repr(C)]
#[derive(bytemuck::Pod,bytemuck::Zeroable,Copy,Clone)]
struct Params {extent:[u32;4],region:[u32;4],m0:[f32;4],m1:[f32;4],coords0:[f32;4],coords1:[f32;4],flags:[u32;4],bbox:[f32;4]}
pub struct MaterialSampler {pipeline:wgpu::ComputePipeline,layout:wgpu::BindGroupLayout,sampler:wgpu::Sampler}
impl MaterialSampler {
    pub fn new(ctx:&GpuContext)->Self {
        let layout=ctx.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {label:None,entries:&[
            wgpu::BindGroupLayoutEntry {binding:0,visibility:wgpu::ShaderStages::COMPUTE,ty:wgpu::BindingType::Buffer {ty:wgpu::BufferBindingType::Storage {read_only:false},has_dynamic_offset:false,min_binding_size:None},count:None},
            wgpu::BindGroupLayoutEntry {binding:1,visibility:wgpu::ShaderStages::COMPUTE,ty:wgpu::BindingType::Texture {sample_type:wgpu::TextureSampleType::Float {filterable:true},view_dimension:wgpu::TextureViewDimension::D2Array,multisampled:false},count:None},
            wgpu::BindGroupLayoutEntry {binding:2,visibility:wgpu::ShaderStages::COMPUTE,ty:wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),count:None},
            wgpu::BindGroupLayoutEntry {binding:3,visibility:wgpu::ShaderStages::COMPUTE,ty:wgpu::BindingType::Buffer {ty:wgpu::BufferBindingType::Uniform,has_dynamic_offset:false,min_binding_size:None},count:None},
        ]});
        let shader=ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {label:Some("PPE retained image/shading"),source:wgpu::ShaderSource::Wgsl(include_str!("retained_material.wgsl").into())});
        let pl=ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {label:None,bind_group_layouts:&[&layout],push_constant_ranges:&[]});
        let pipeline=ctx.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {label:None,layout:Some(&pl),module:&shader,entry_point:Some("main"),compilation_options:Default::default(),cache:None});
        let sampler=ctx.device.create_sampler(&wgpu::SamplerDescriptor {mag_filter:wgpu::FilterMode::Linear,min_filter:wgpu::FilterMode::Linear,mipmap_filter:wgpu::FilterMode::Linear,..Default::default()});
        Self{pipeline,layout,sampler}
    }
    pub fn encode(&self,ctx:&GpuContext,e:&mut wgpu::CommandEncoder,target:&InkSurface,material:&Material,matrix:Matrix,interpolate:bool)->Result<(),GpuError> {
        self.encode_region(ctx,e,target,material,matrix,interpolate,[0,0,target.width,target.height])
    }
    /// PERF (audit 2026-09-25 §R25.GPU.33): giữ tọa độ lấy mẫu toàn frame,
    /// chỉ bỏ invocation nằm ngoài vùng đối tượng thực sự được composite.
    pub fn encode_region(&self,ctx:&GpuContext,e:&mut wgpu::CommandEncoder,target:&InkSurface,material:&Material,
        matrix:Matrix,interpolate:bool,region:[u32;4])->Result<(),GpuError> {
        let Some(m)=matrix.invert() else{return Err(err("Ma trận resource suy biến"));};
        let bbox=material.bbox.map(|b|[b.x0,b.y0,b.x1,b.y1]).unwrap_or([-f32::MAX,-f32::MAX,f32::MAX,f32::MAX]);
        let params=Params{region,extent:[target.width,target.height,target.channels,material.kind],m0:[m.a,m.b,m.c,m.d],m1:[m.e,m.f,material.size[0] as f32,material.size[1] as f32],
            coords0:material.coordinates[..4].try_into().unwrap(),coords1:material.coordinates[4..].try_into().unwrap(),flags:[material.extend[0],material.extend[1],material.stencil as u32,interpolate as u32],bbox};
        let p=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:None,contents:bytemuck::bytes_of(&params),usage:wgpu::BufferUsages::UNIFORM});
        let bind=ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {label:None,layout:&self.layout,entries:&[
            wgpu::BindGroupEntry {binding:0,resource:target.buffer.as_entire_binding()},wgpu::BindGroupEntry {binding:1,resource:wgpu::BindingResource::TextureView(&material.view)},
            wgpu::BindGroupEntry {binding:2,resource:wgpu::BindingResource::Sampler(&self.sampler)},wgpu::BindGroupEntry {binding:3,resource:p.as_entire_binding()},]});
        let mut pass=e.begin_compute_pass(&Default::default());pass.set_pipeline(&self.pipeline);pass.set_bind_group(0,&bind,&[]);pass.dispatch_workgroups(region[2].div_ceil(8),region[3].div_ceil(8),1);Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{icc_resolve::{IccProofLut,IccResolve},ink_surface::InkCompositor};
    use print_engine::{color::{ColorSpace,RenderIntent,PdfFunction},image::sampler::decode_image};
    use lopdf::{dictionary,Document,Stream,Object};
    #[test]
    fn material_image_and_radial_shader_match_source_samples() {
        let ctx=GpuContext::new_sync().unwrap();let sampler=MaterialSampler::new(&ctx);
        let cm=ColorManager::from_cmyk_profile(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc"),RenderIntent::RelativeColorimetric).unwrap();
        let mut space=InkSpace::preview();let lut=IccProofLut::build(&cm,17,Default::default()).unwrap();
        let image=Arc::new(decode_image(&Document::new(),&Object::Stream(Stream::new(dictionary! {"Subtype"=>"Image","Width"=>2,"Height"=>1,"BitsPerComponent"=>8,"ColorSpace"=>"DeviceCMYK"},vec![255,0,0,0,0,255,0,0])),None,&mut Default::default()).unwrap());
        let material=Material::image(&ctx,&image,&mut space,&cm).unwrap();
        let shading=Shading {kind:ShadingKind::Radial {coords:[0.,0.,0.,0.,0.,2.],domain:[0.,1.],extend:[true,true]},colorspace:ColorSpace::DeviceCMYK,
            function:Some(PdfFunction::Exponential {domain:vec![0.,1.],c0:vec![0.;4],c1:vec![1.,0.,0.,0.],n:1.,range:None}),bbox:None,background:None};
        let radial=Material::shading(&ctx,&shading,&mut space,&cm).unwrap();
        for (resource,matrix,expected) in [(&material,Matrix::scale(2.,1.),vec![[1.,0.,0.,0.],[0.,1.,0.,0.]]),
            (&radial,Matrix::IDENTITY,vec![[0.354,0.,0.,0.],[0.791,0.,0.,0.]])] {
            let src=InkSurface::new(&ctx,2,1,4).unwrap();let dst=InkSurface::new(&ctx,2,1,4).unwrap();let c=InkCompositor::new(&ctx);
            let resolve=IccResolve::new(&ctx,wgpu::TextureFormat::Rgba8Unorm,&lut,&space).unwrap();let out=ctx.create_target_texture(2,1,wgpu::TextureFormat::Rgba8Unorm,None);
            let mut e=ctx.device.create_command_encoder(&Default::default());sampler.encode(&ctx,&mut e,&src,resource,matrix,false).unwrap();
            let mut p=dst.dispatch(2);p.flags[3]=1;c.encode(&ctx,&mut e,&dst,Some(&src),None,None,None,&[],&p).unwrap();
            resolve.encode(&ctx,&mut e,&dst,&out.create_view(&Default::default())).unwrap();ctx.queue.submit([e.finish()]);
            let got=ctx.readback_texture_rgba8(&out,2,1).unwrap();let expected=cm.cmyk_to_srgb_batch(&expected).unwrap();
            for (a,b) in got.chunks_exact(4).zip(expected) {for ch in 0..3 {assert!(a[ch].abs_diff(b[ch])<=3,"{a:?} != {b:?}");}}
        }
    }
}
