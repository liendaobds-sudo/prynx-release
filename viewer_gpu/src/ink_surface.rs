//! PERF (audit 2026-09-25 §R25.GPU.04): mực N kênh, alpha, shape và alpha
//! tích lũy nhóm là các mặt phẳng độc lập. K không bao giờ đóng vai alpha.
use crate::{GpuContext, GpuError};
use wgpu::util::DeviceExt;

#[derive(Clone)]
pub struct InkSurface {
    pub buffer: wgpu::Buffer,
    pub width: u32,
    pub height: u32,
    pub channels: u32,
}

#[derive(Default)]
pub struct InkSurfacePool {
    size:(u32,u32,u32), surfaces:Vec<InkSurface>, cursor:usize, free:Vec<InkSurface>,
}
impl InkSurfacePool {
    pub fn clear(&mut self) {
        self.surfaces.clear();
        self.free.clear();
        self.cursor = 0;
        self.size = (0, 0, 0);
    }
    pub fn begin_frame(&mut self,width:u32,height:u32,channels:u32) {
        if self.size!=(width,height,channels) {self.surfaces.clear();self.size=(width,height,channels);}
        self.cursor=0;self.free.clear();
    }
    pub fn take(&mut self,ctx:&GpuContext,encoder:&mut wgpu::CommandEncoder)->Result<InkSurface,GpuError> {
        if let Some(surface)=self.free.pop() {encoder.clear_buffer(&surface.buffer,0,None);return Ok(surface);}
        if self.cursor==self.surfaces.len() {self.surfaces.push(InkSurface::new(ctx,self.size.0,self.size.1,self.size.2)?);}
        let surface=self.surfaces[self.cursor].clone();self.cursor+=1;
        encoder.clear_buffer(&surface.buffer,0,None);Ok(surface)
    }
    /// Pass đã encode giữ handle; tái sử dụng chỉ ghi ở pass sau trong cùng queue.
    pub fn recycle(&mut self,surface:InkSurface) {self.free.push(surface);}
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct InkDispatch {
    pub extent: [u32; 4], // width, height, channels, operation
    pub region: [u32; 4],
    pub flags: [u32; 4], // blend, knockout, overprint, isolated
    pub participation: [u32; 4], // 64-bit declared channels, coverage present, mask present
    pub opacity: [f32; 4], // alpha, shape, alpha-is-shape, reserved
}

pub struct InkCompositor {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    one: wgpu::Buffer,
}

impl InkSurface {
    pub fn new(ctx: &GpuContext, width: u32, height: u32, channels: u32) -> Result<Self, GpuError> {
        let bytes = u64::from(width).saturating_mul(u64::from(height)).saturating_mul(u64::from(channels)+3).saturating_mul(4);
        if width==0 || height==0 || !(4..=64).contains(&channels) ||
            bytes>ctx.device.limits().max_storage_buffer_binding_size as u64 {
            return Err(GpuError::UnsupportedPass("Surface mực vượt khả năng storage của thiết bị".into()));
        }
        Ok(Self { width, height, channels, buffer:ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label:Some("PPE mực + alpha + shape + group-alpha"), size:bytes,
            usage:wgpu::BufferUsages::STORAGE|wgpu::BufferUsages::COPY_SRC|wgpu::BufferUsages::COPY_DST,
            mapped_at_creation:false,
        }) })
    }
    pub fn snapshot(&self, ctx:&GpuContext, encoder:&mut wgpu::CommandEncoder)->Result<Self,GpuError> {
        let out=Self::new(ctx,self.width,self.height,self.channels)?;
        encoder.copy_buffer_to_buffer(&self.buffer,0,&out.buffer,0,self.buffer.size());
        Ok(out)
    }
    pub fn dispatch(&self, operation:u32)->InkDispatch {
        InkDispatch { extent:[self.width,self.height,self.channels,operation], region:[0,0,self.width,self.height],
            flags:[0;4], participation:[u32::MAX,u32::MAX,0,0], opacity:[1.0,1.0,0.0,0.0] }
    }
}

impl InkCompositor {
    pub fn new(ctx:&GpuContext)->Self {
        let entries:Vec<_>=(0..7).map(|binding|wgpu::BindGroupLayoutEntry { binding,
            visibility:wgpu::ShaderStages::COMPUTE,
            ty:wgpu::BindingType::Buffer {ty:wgpu::BufferBindingType::Storage {read_only:binding!=0},
                has_dynamic_offset:false,min_binding_size:None},count:None }).collect();
        let layout=ctx.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {label:Some("PPE N-channel bindings"),entries:&entries});
        let shader=ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {label:Some("PPE alpha/shape compositor"),
            source:wgpu::ShaderSource::Wgsl(include_str!("ink_surface.wgsl").into())});
        let pipeline_layout=ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label:None,bind_group_layouts:&[&layout],push_constant_ranges:&[] });
        let pipeline=ctx.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {label:Some("PPE N-channel composite"),
            layout:Some(&pipeline_layout),module:&shader,entry_point:Some("main"),
            compilation_options:Default::default(),cache:None });
        let one=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:None,
            contents:bytemuck::cast_slice(&[1.0f32]),usage:wgpu::BufferUsages::STORAGE});
        Self {pipeline,layout,one}
    }

    /// `source` và `backdrop` luôn là snapshot khác đích: không tạo alias đọc/ghi.
    pub fn encode(&self,ctx:&GpuContext,encoder:&mut wgpu::CommandEncoder,target:&InkSurface,
        source:Option<&InkSurface>,backdrop:Option<&InkSurface>,coverage:Option<&wgpu::Buffer>,
        mask:Option<&wgpu::Buffer>,ink:&[f32],params:&InkDispatch)->Result<(),GpuError> {
        for surface in [source,backdrop].into_iter().flatten() {
            if (surface.width,surface.height,surface.channels)!=(target.width,target.height,target.channels) {
                return Err(GpuError::UnsupportedPass("Surface nhóm không cùng kích thước/kênh".into()));
            }
        }
        let p=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:None,
            contents:bytemuck::bytes_of(params),usage:wgpu::BufferUsages::STORAGE});
        let mut colors=vec![0.0f32;if params.extent[3]==3 {256}else{target.channels as usize}];
        for (dst,src) in colors.iter_mut().zip(ink) {*dst=*src;}
        let colors=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {label:None,
            contents:bytemuck::cast_slice(&colors),usage:wgpu::BufferUsages::STORAGE});
        let buffers=[&target.buffer,source.map(|s|&s.buffer).unwrap_or(&self.one),
            backdrop.map(|s|&s.buffer).unwrap_or(&self.one),coverage.unwrap_or(&self.one),
            mask.unwrap_or(&self.one),&colors,&p];
        let entries:Vec<_>=buffers.iter().enumerate().map(|(binding,buffer)|wgpu::BindGroupEntry {
            binding:binding as u32,resource:buffer.as_entire_binding() }).collect();
        let bind=ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {label:None,layout:&self.layout,entries:&entries});
        let mut pass=encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {label:Some("PPE ink composite"),timestamp_writes:None});
        pass.set_pipeline(&self.pipeline);pass.set_bind_group(0,&bind,&[]);
        pass.dispatch_workgroups(params.region[2].div_ceil(8),params.region[3].div_ceil(8),1);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pixels(ctx:&GpuContext,s:&InkSurface)->Vec<f32> {
        let b=ctx.device.create_buffer(&wgpu::BufferDescriptor {label:None,size:s.buffer.size(),usage:wgpu::BufferUsages::MAP_READ|wgpu::BufferUsages::COPY_DST,mapped_at_creation:false});
        let mut e=ctx.device.create_command_encoder(&Default::default());e.copy_buffer_to_buffer(&s.buffer,0,&b,0,b.size());ctx.queue.submit([e.finish()]);
        let (tx,rx)=std::sync::mpsc::channel();b.slice(..).map_async(wgpu::MapMode::Read,move|r|{tx.send(r).unwrap();});
        ctx.device.poll(wgpu::Maintain::Wait);rx.recv().unwrap().unwrap();
        let values=bytemuck::cast_slice(&b.slice(..).get_mapped_range()).to_vec();b.unmap();values
    }
    fn fill(ctx:&GpuContext,c:&InkCompositor,e:&mut wgpu::CommandEncoder,s:&InkSurface,ink:&[f32],a:f32,shape:f32) {
        let mut p=s.dispatch(0);p.opacity=[a,shape,0.0,0.0];c.encode(ctx,e,s,None,None,None,None,ink,&p).unwrap();
    }
    #[test]
    fn separate_alpha_shape_and_spot_survive_normal_and_overprint() {
        let ctx=GpuContext::new_sync().unwrap();let c=InkCompositor::new(&ctx);let s=InkSurface::new(&ctx,1,1,5).unwrap();
        let mut e=ctx.device.create_command_encoder(&Default::default());
        fill(&ctx,&c,&mut e,&s,&[1.,0.,0.,0.,1.],0.5,1.0);
        let mut p=s.dispatch(0);p.flags[2]=1;p.participation[0]=2;
        c.encode(&ctx,&mut e,&s,None,None,None,None,&[0.,1.,0.,0.,0.],&p).unwrap();ctx.queue.submit([e.finish()]);
        let v=pixels(&ctx,&s);assert!((v[0]-1.0).abs()<1e-5);assert_eq!(v[1],1.0);assert_eq!(v[3],0.0);
        assert_eq!(v[4],1.0);assert_eq!(v[5],1.0);assert_eq!(v[6],1.0);
    }
    #[test]
    fn separable_blend_boundary_values_match_pdf_formula(){
        use print_engine::blend::BlendMode::*;
        let ctx=GpuContext::new_sync().unwrap();let c=InkCompositor::new(&ctx);let dst=InkSurface::new(&ctx,1,1,4).unwrap();
        for (id,mode) in [Normal,Multiply,Screen,Overlay,Darken,Lighten,ColorDodge,ColorBurn,HardLight,SoftLight,Difference,Exclusion].into_iter().enumerate(){
            for (b,s) in [(0.,0.),(0.,1.),(1.,0.),(1.,1.),(0.25,0.75),(0.7,0.3)]{
                let mut e=ctx.device.create_command_encoder(&Default::default());e.clear_buffer(&dst.buffer,0,None);fill(&ctx,&c,&mut e,&dst,&[b;4],1.,1.);
                let mut p=dst.dispatch(0);p.flags[0]=id as u32;c.encode(&ctx,&mut e,&dst,None,None,None,None,&[s;4],&p).unwrap();ctx.queue.submit([e.finish()]);
                let got=pixels(&ctx,&dst);let expected=mode.blend_ink(b,s);assert!((got[0]-expected).abs()<1e-5,"{mode:?} {b} {s}: {} != {expected}",got[0]);
            }
        }
    }

    #[test]
    fn isolated_group_uses_coverage_only_once() {
        let ctx=GpuContext::new_sync().unwrap();let c=InkCompositor::new(&ctx);let dst=InkSurface::new(&ctx,1,1,4).unwrap();let child=InkSurface::new(&ctx,1,1,4).unwrap();
        let mut e=ctx.device.create_command_encoder(&Default::default());fill(&ctx,&c,&mut e,&child,&[1.,0.,0.,0.],0.5,1.0);
        let mut p=dst.dispatch(2);p.flags[3]=1;p.opacity[0]=0.5;
        c.encode(&ctx,&mut e,&dst,Some(&child),None,None,None,&[],&p).unwrap();ctx.queue.submit([e.finish()]);
        let v=pixels(&ctx,&dst);assert!((v[0]-0.25).abs()<1e-5);assert_eq!(v[3],0.0);assert!((v[4]-0.25).abs()<1e-5);assert_eq!(v[5],1.0);
    }
    #[test]
    fn knockout_removes_previous_shape_even_when_new_object_is_transparent() {
        let ctx=GpuContext::new_sync().unwrap();let c=InkCompositor::new(&ctx);let dst=InkSurface::new(&ctx,1,1,4).unwrap();let initial=InkSurface::new(&ctx,1,1,4).unwrap();
        let mut e=ctx.device.create_command_encoder(&Default::default());fill(&ctx,&c,&mut e,&dst,&[1.,0.,0.,0.],1.0,1.0);
        let mut p=dst.dispatch(0);p.flags[1]=1;p.opacity=[0.25,1.0,0.0,0.0];
        c.encode(&ctx,&mut e,&dst,None,Some(&initial),None,None,&[0.,1.,0.,0.],&p).unwrap();ctx.queue.submit([e.finish()]);
        let v=pixels(&ctx,&dst);assert_eq!(v[0],0.0);assert_eq!(v[1],0.25);assert_eq!(v[4],0.25);assert_eq!(v[5],1.0);
    }
}
