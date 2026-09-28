//! Replay resource không hỗ trợ bằng PPE; upload mực/alpha trước composite GPU.
use crate::{GpuContext,GpuError,ink_surface::InkSurface};
use print_engine::{content::Renderer,shading::Shading,geom::Matrix,color::icc::ColorManager,ink::{InkSpace,ChannelMask}};
use wgpu::util::DeviceExt;
pub fn shading(ctx:&GpuContext,encoder:&mut wgpu::CommandEncoder,target:&InkSurface,shading:&Shading,
    matrix:Matrix,space:&InkSpace,color:&ColorManager)->Result<ChannelMask,GpuError>{
    let err=|e:print_engine::error::PpeError|GpuError::UnsupportedPass(e.to_string());
    let mut registry=space.clone();let mut warnings=Default::default();
    let declared=shading.colorspace.to_ink(&shading.colorspace.initial_components(),&mut registry,&mut warnings,Some(color)).map_err(err)?.map_or(ChannelMask::EMPTY,|(_,m)|m);
    let (buffer,warnings)=Renderer::replay_shading_resource(shading,matrix,target.width,target.height,registry,color).map_err(err)?;
    if buffer.space().len()!=target.channels as usize || warnings.dropped_objects>0 || !warnings.approximated_colorspaces.is_empty(){
        return Err(GpuError::UnsupportedPass(format!("Fallback shading không giữ được color contract: {warnings:?}")));
    }
    let n=target.channels as usize;let count=target.width as usize*target.height as usize;let mut data=vec![0.;count*(n+3)];
    for i in 0..count {for ch in 0..n {data[i*(n+3)+ch]=buffer.plane(ch)[i];}
        let alpha=buffer.alpha_plane()[i];data[i*(n+3)+n..i*(n+3)+n+3].fill(alpha);}
    let source=ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor{label:Some("PPE resource fallback"),contents:bytemuck::cast_slice(&data),usage:wgpu::BufferUsages::COPY_SRC});
    encoder.copy_buffer_to_buffer(&source,0,&target.buffer,0,target.buffer.size());Ok(declared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icc_resolve::{IccProofLut,IccResolve};
    use print_engine::{color::{ColorSpace,PdfFunction,RenderIntent},geom::Rect,shading::{ShadingKind,mesh::{MeshTriangle,MeshPatch}}};
    #[test]
    fn function_uses_both_coordinates_and_mesh_keeps_transparent_outside(){
        let ctx=GpuContext::new_sync().unwrap();let space=InkSpace::preview();
        let cm=ColorManager::from_cmyk_profile(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc"),RenderIntent::RelativeColorimetric).unwrap();
        let lut=IccProofLut::build(&cm,33,Default::default()).unwrap();let resolve=IccResolve::new(&ctx,wgpu::TextureFormat::Rgba8Unorm,&lut,&space).unwrap();
        let function=Shading{kind:ShadingKind::FunctionBased{domain:[0.,1.,0.,1.],matrix:Matrix::IDENTITY},colorspace:ColorSpace::DeviceCMYK,
            function:Some(PdfFunction::Identity{n_out:4}),bbox:None,background:None};
        let mesh=Shading{kind:ShadingKind::Mesh{triangles:vec![MeshTriangle{p:[[0.,0.],[2.,0.],[0.,2.]],c:std::array::from_fn(|_|vec![1.,0.,0.,0.])}]},
            colorspace:ColorSpace::DeviceCMYK,function:None,bbox:Some(Rect::new(0.,0.,1.,2.)),background:None};
        let patch=Shading{kind:ShadingKind::Patches{patches:vec![MeshPatch{
            grid:std::array::from_fn(|i|[(i%4) as f32/3.,(i/4) as f32/3.]),
            c:[vec![0.],vec![1.],vec![1.],vec![0.]],
        }]},colorspace:ColorSpace::DeviceCMYK,function:Some(PdfFunction::Exponential{
            domain:vec![0.,1.],c0:vec![0.;4],c1:vec![0.,0.,0.,1.],n:2.,range:None,
        }),bbox:None,background:None};
        for (resource,matrix,expected) in [(&function,Matrix::scale(2.,2.),vec![[0.25,0.25,0.,0.],[0.75,0.25,0.,0.],[0.25,0.75,0.,0.],[0.75,0.75,0.,0.]]),
            (&mesh,Matrix::IDENTITY,vec![[1.,0.,0.,0.],[0.;4],[1.,0.,0.,0.],[0.;4]]),
            (&patch,Matrix::scale(2.,2.),vec![[0.,0.,0.,0.0625],[0.,0.,0.,0.5625],[0.,0.,0.,0.0625],[0.,0.,0.,0.5625]])]{
            let target=InkSurface::new(&ctx,2,2,4).unwrap();let out=ctx.create_target_texture(2,2,wgpu::TextureFormat::Rgba8Unorm,None);
            let mut e=ctx.device.create_command_encoder(&Default::default());let declared=shading(&ctx,&mut e,&target,resource,matrix,&space,&cm).unwrap();assert_eq!(declared,ChannelMask::PROCESS);
            resolve.encode(&ctx,&mut e,&target,&out.create_view(&Default::default())).unwrap();ctx.queue.submit([e.finish()]);
            let got=ctx.readback_texture_rgba8(&out,2,2).unwrap();let expected=cm.cmyk_to_srgb_batch(&expected).unwrap();
            for (a,b) in got.chunks_exact(4).zip(expected){for ch in 0..3{assert!(a[ch].abs_diff(b[ch])<=2,"{a:?} != {b:?}");}}
        }
    }
}
