//! ICC đầu ra lấy mẫu từ LCMS/PPE, gộp spot ở đúng biên resolve.
use crate::{GpuContext,GpuError,ink_surface::InkSurface};
use print_engine::{color::icc::{ColorManager,SoftProofSettings},ink::InkSpace};
use wgpu::util::DeviceExt;
use std::sync::Arc;
use rayon::prelude::*;

pub struct IccProofLut { pub grid:u32, pub values:Vec<[f32;4]> }
impl IccProofLut {
    pub fn build(color:&ColorManager,grid:u32,settings:SoftProofSettings)->Result<Self,GpuError> {
        if !(2..=65).contains(&grid) {return Err(GpuError::UnsupportedPass("Lưới ICC không hợp lệ".into()));}
        let count=(grid as usize).pow(4);
        // PERF (audit 2026-09-25 §R25.GPU.31): mỗi lô giữ handle LCMS riêng.
        // Indexed parallel iterator giữ nguyên thứ tự LUT và không đổi lưới màu.
        let jobs=(0..count).step_by(65536).map(|base| {
            color.fork_for_render().map(|cm|(base,cm)).map_err(|e|GpuError::UnsupportedPass(e.to_string()))
        }).collect::<Result<Vec<_>,_>>()?;
        let batches=jobs.into_par_iter().map(|(base,color)| {
            let inputs:Vec<[f32;4]>=(base..(base+65536).min(count)).map(|mut i|{
                std::array::from_fn(|_|{let v=(i%grid as usize) as f32/(grid-1) as f32;i/=grid as usize;v})
            }).collect();
            color.cmyk_to_srgb_batch_with_settings(&inputs,settings)
                .ok_or_else(||GpuError::UnsupportedPass("ICC không cung cấp transform ra màn hình".into()))
        }).collect::<Result<Vec<_>,_>>()?;
        let values=batches.into_iter().flatten().map(|v|[v[0] as f32/255.,v[1] as f32/255.,v[2] as f32/255.,1.]).collect();
        Ok(Self{grid,values})
    }
}

/// Dữ liệu bất biến dùng chung cho các trang có cùng profile/format/device.
pub struct IccResolveResources {
    gpu_id:u64,pipeline:wgpu::RenderPipeline,layout:wgpu::BindGroupLayout,
    lut:wgpu::Buffer,grid:u32,
}
impl IccResolveResources {
    pub fn new(ctx:&GpuContext,format:wgpu::TextureFormat,lut:&IccProofLut)->Self {
        let lut_buffer=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:Some("PPE ICC 4D LUT"),contents:bytemuck::cast_slice(&lut.values),usage:wgpu::BufferUsages::STORAGE});
        let entries:Vec<_>=(0..5).map(|binding|wgpu::BindGroupLayoutEntry {binding,visibility:wgpu::ShaderStages::FRAGMENT,
            ty:wgpu::BindingType::Buffer {ty:wgpu::BufferBindingType::Storage {read_only:true},has_dynamic_offset:false,min_binding_size:None},count:None}).collect();
        let layout=ctx.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {label:None,entries:&entries});
        let pl=ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {label:None,bind_group_layouts:&[&layout],push_constant_ranges:&[]});
        let shader=ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {label:Some("PPE ICC resolve"),source:wgpu::ShaderSource::Wgsl(include_str!("icc_resolve.wgsl").into())});
        let constants=std::collections::HashMap::from([("TARGET_SRGB".to_string(),if format.is_srgb(){1.0}else{0.0})]);
        let pipeline=ctx.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {label:None,layout:Some(&pl),
            vertex:wgpu::VertexState {module:&shader,entry_point:Some("vs"),compilation_options:Default::default(),buffers:&[]},
            fragment:Some(wgpu::FragmentState {module:&shader,entry_point:Some("fs"),compilation_options:wgpu::PipelineCompilationOptions {constants:&constants,..Default::default()},
                targets:&[Some(wgpu::ColorTargetState {format,blend:None,write_mask:wgpu::ColorWrites::ALL})]}),
            primitive:Default::default(),depth_stencil:None,multisample:Default::default(),multiview:None,cache:None});
        Self{gpu_id:ctx.identity(),pipeline,layout,lut:lut_buffer,grid:lut.grid}
    }
}
pub struct IccResolve {shared:Arc<IccResolveResources>,spots:wgpu::Buffer,channels:u32}
impl IccResolve {
    pub fn new(ctx:&GpuContext,format:wgpu::TextureFormat,lut:&IccProofLut,space:&InkSpace)->Result<Self,GpuError> {
        Self::with_resources(ctx,Arc::new(IccResolveResources::new(ctx,format,lut)),space)
    }
    pub fn with_resources(ctx:&GpuContext,shared:Arc<IccResolveResources>,space:&InkSpace)->Result<Self,GpuError> {
        if ctx.identity()!=shared.gpu_id {return Err(GpuError::UnsupportedPass("Tài nguyên ICC thuộc GPU khác".into()));}
        let mut spots=Vec::<[f32;4]>::new();
        for ch in 4..space.len() {
            let alt=space.spot_alternate(ch).ok_or_else(||GpuError::UnsupportedPass(format!("Kênh {} thiếu tint transform",space.colorants()[ch].name())))?;
            spots.extend_from_slice(alt.samples());
        }
        if spots.is_empty(){spots.push([0.;4]);}
        let spots=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:Some("PPE spot tint LUT"),contents:bytemuck::cast_slice(&spots),usage:wgpu::BufferUsages::STORAGE});
        Ok(Self{shared,spots,channels:space.len() as u32})
    }
    pub fn encode(&self,ctx:&GpuContext,encoder:&mut wgpu::CommandEncoder,input:&InkSurface,output:&wgpu::TextureView)->Result<(),GpuError> {
        self.encode_page(ctx,encoder,input,output,[0.,0.,input.width as f32,input.height as f32])
    }
    pub fn encode_page(&self,ctx:&GpuContext,encoder:&mut wgpu::CommandEncoder,input:&InkSurface,output:&wgpu::TextureView,page:[f32;4])->Result<(),GpuError> {
        if input.channels!=self.channels {return Err(GpuError::UnsupportedPass("InkSpace và ICC resolve khác revision".into()));}
        let p=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:None,contents:bytemuck::cast_slice(&[input.width,input.height,input.channels,self.shared.grid]),usage:wgpu::BufferUsages::STORAGE});
        let page=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:None,contents:bytemuck::cast_slice(&page),usage:wgpu::BufferUsages::STORAGE});
        let buffers=[&input.buffer,&self.shared.lut,&self.spots,&p,&page];
        let entries:Vec<_>=buffers.iter().enumerate().map(|(i,b)|wgpu::BindGroupEntry {binding:i as u32,resource:b.as_entire_binding()}).collect();
        let bind=ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {label:None,layout:&self.shared.layout,entries:&entries});
        let mut pass=encoder.begin_render_pass(&wgpu::RenderPassDescriptor {label:Some("PPE profile resolve"),color_attachments:&[Some(wgpu::RenderPassColorAttachment {view:output,resolve_target:None,
            ops:wgpu::Operations {load:wgpu::LoadOp::Clear(wgpu::Color::WHITE),store:wgpu::StoreOp::Store}})],depth_stencil_attachment:None,timestamp_writes:None,occlusion_query_set:None});
        pass.set_pipeline(&self.shared.pipeline);pass.set_bind_group(0,&bind,&[]);pass.draw(0..3,0..1);Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ink_surface::InkCompositor;
    use print_engine::{color::RenderIntent,ink::{Colorant,SpotAlternate}};
    #[test]
    fn gpu_profile_resolve_matches_lcms_samples_and_spot_tint() {
        let ctx=GpuContext::new_sync().unwrap();
        let profile=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc");
        let cm=ColorManager::from_cmyk_profile(&profile,RenderIntent::RelativeColorimetric).unwrap();
        let lut=IccProofLut::build(&cm,33,Default::default()).unwrap();
        let mut space=InkSpace::preview();let spot=space.register(Colorant::Spot("Test".into())).unwrap();
        space.set_spot_alternate(spot,SpotAlternate::from_lut((0..33).map(|i|[0.,(i as f32/32.).powi(2),0.,0.]).collect()).unwrap());
        let inks=[[0.0,0.0,0.0,0.0,0.0],[0.25,0.5,0.75,0.0,0.0],[0.73,0.13,0.51,0.19,0.0],[0.,0.,0.,0.,0.5]];
        let expected=cm.cmyk_to_srgb_batch(&[[0.,0.,0.,0.],[0.25,0.5,0.75,0.],[0.73,0.13,0.51,0.19],[0.,0.25,0.,0.]]).unwrap();
        for format in [wgpu::TextureFormat::Rgba8Unorm,wgpu::TextureFormat::Rgba8UnormSrgb] {
            let resolve=IccResolve::new(&ctx,format,&lut,&space).unwrap();let c=InkCompositor::new(&ctx);let s=InkSurface::new(&ctx,4,1,5).unwrap();
            let texture=ctx.create_target_texture(4,1,format,None);let mut e=ctx.device.create_command_encoder(&Default::default());
            for (i,ink) in inks.iter().enumerate() {let mut p=s.dispatch(0);p.region=[i as u32,0,1,1];c.encode(&ctx,&mut e,&s,None,None,None,None,ink,&p).unwrap();}
            resolve.encode(&ctx,&mut e,&s,&texture.create_view(&Default::default())).unwrap();ctx.queue.submit([e.finish()]);
            let pixels=ctx.readback_texture_rgba8(&texture,4,1).unwrap();
            for (got,want) in pixels.chunks_exact(4).zip(&expected) {for ch in 0..3 {assert!(got[ch].abs_diff(want[ch])<=2,"{format:?}: {got:?} != {want:?}");}}
        }
    }
}
