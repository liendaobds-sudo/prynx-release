use std::sync::Arc;
use print_engine::{scene::retained::RetainedPage,content::RenderOptions,color::{icc::ColorManager,RenderIntent}};
use viewer_gpu::{GpuContext,retained_renderer::RetainedRenderer};
#[test]
#[ignore="PRYNX_R01_PDF, PRYNX_STARTUP_OUT"]
fn r01_page2_mask_pixel_parity(){
 let doc=lopdf::Document::load(std::env::var("PRYNX_R01_PDF").unwrap()).unwrap();
 let profile=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc");
 let cm=ColorManager::from_cmyk_profile(&profile,RenderIntent::RelativeColorimetric).unwrap();
 let scene=Arc::new(RetainedPage::compile(&doc,2,RenderOptions::viewer(),Some(&cm)).unwrap());
 let ctx=GpuContext::new_sync().unwrap();let renderer=RetainedRenderer::new(&ctx,scene.clone(),&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
 let out=std::path::PathBuf::from(std::env::var("PRYNX_STARTUP_OUT").unwrap());std::fs::create_dir_all(&out).unwrap();
 let target=ctx.create_target_texture(216,162,wgpu::TextureFormat::Rgba8Unorm,None);
 for (i,(s,x,y)) in [(104./72./5.,0.,0.),(1.01,-143.25,-56.75)].into_iter().enumerate(){
  let stats=renderer.render(&ctx,&target.create_view(&Default::default()),216,162,scene.page_to_view(s,x,y)).unwrap();println!("camera={i} {stats:?}");
  std::fs::write(out.join(format!("page2-camera-{i}.rgba")),ctx.readback_texture_rgba8(&target,216,162).unwrap()).unwrap();
 }
}
