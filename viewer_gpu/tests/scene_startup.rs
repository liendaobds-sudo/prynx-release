//! PERF (audit 2026-09-25 §R25.GPU.31): đo cùng PDF/camera, lưu pixel đối chiếu.
use std::{sync::Arc, time::Instant};
use print_engine::{scene::retained::RetainedPage, content::RenderOptions, color::{icc::ColorManager,RenderIntent}};
use viewer_gpu::{GpuContext,retained_renderer::{RetainedRenderer,RendererResources}};

#[test]
#[ignore="R01 local: PRYNX_R01_PDF, PRYNX_STARTUP_OUT"]
fn r01_preparation_breakdown_and_pixels() {
    let path=std::env::var("PRYNX_R01_PDF").unwrap();
    let out=std::path::PathBuf::from(std::env::var("PRYNX_STARTUP_OUT").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    let start=Instant::now();let doc=lopdf::Document::load(path).unwrap();let parse=start.elapsed();
    let profile=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc");
    let cm=ColorManager::from_cmyk_profile(&profile,RenderIntent::RelativeColorimetric).unwrap();
    let page=std::env::var("PRYNX_STARTUP_PAGE").ok().and_then(|s|s.parse().ok()).unwrap_or(1);
    let start=Instant::now();let scene=Arc::new(RetainedPage::compile(&doc,page,RenderOptions::viewer(),Some(&cm)).unwrap());
    println!("parse={parse:?} compile={:?}",start.elapsed());
    let ctx=GpuContext::new_sync().unwrap();println!("adapter={:?}",ctx.adapter_info);
    let mut csv=String::from("run,validate_us,materials_us,lut_us,pipelines_us,total_us,first_frame_us\n");
    let started=Instant::now();let resources=Arc::new(RendererResources::new(&ctx,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap());
    println!("common={:?}",resources.preparation);
    std::fs::write(out.join("common-us.txt"),started.elapsed().as_micros().to_string()).unwrap();
    let mut cached:Option<RetainedRenderer>=None;
    let read=|name:&str,default:u32|std::env::var(name).ok().and_then(|s|s.parse().ok()).unwrap_or(default);
    let width=read("PRYNX_STARTUP_WIDTH",1081);let height=read("PRYNX_STARTUP_HEIGHT",811);
    let scale=std::env::var("PRYNX_STARTUP_SCALE").ok().and_then(|s|s.parse().ok()).unwrap_or(104./72.);
    for run in 0..read("PRYNX_STARTUP_RUNS",3) {
        let renderer=if let Some(old)=&cached {old.fork_for_view().unwrap()}
            else {RetainedRenderer::with_resources(&ctx,scene.clone(),resources.clone()).unwrap()};
        let p=&renderer.preparation;println!("run={run} prepare={p:?}");
        let target=ctx.create_target_texture(width,height,wgpu::TextureFormat::Rgba8Unorm,None);
        for (i,(scale,x,y)) in [(scale,0.,0.),(5.37,-912.25,-421.75)].into_iter().enumerate() {
            let began=Instant::now();let stats=renderer.render(&ctx,&target.create_view(&Default::default()),width,height,scene.page_to_view(scale,x,y)).unwrap();
            ctx.device.poll(wgpu::Maintain::Wait);println!("run={run} camera={i} stats={stats:?}");let frame=began.elapsed().as_micros();
            let pixels=ctx.readback_texture_rgba8(&target,width,height).unwrap();
            std::fs::write(out.join(format!("run-{run}-camera-{i}.rgba")),pixels).unwrap();
            if i==0 {csv.push_str(&format!("{run},{},{},{},{},{},{frame}\n",p.validate_us,p.materials_us,p.lut_us,p.pipelines_us,p.total_us));}
        }
        println!("run={run} materials={}",renderer.material_count());
        cached=Some(renderer);
    }
    std::fs::write(out.join("timing.csv"),csv).unwrap();
}

#[test]
#[ignore="V27 PDF thật: PRYNX_R01_PDF, PRYNX_ROI_OUT; không mở cửa sổ"]
fn r01_partial_regions_match_full_frame_pixels(){
    let path=std::env::var("PRYNX_R01_PDF").unwrap();let out=std::path::PathBuf::from(std::env::var("PRYNX_ROI_OUT").unwrap());std::fs::create_dir_all(&out).unwrap();
    let doc=lopdf::Document::load(path).unwrap();let cm=color();
    let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(&cm)).unwrap());
    let ctx=GpuContext::new_sync().unwrap();let renderer=RetainedRenderer::new(&ctx,scene.clone(),&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
    let (w,h)=(998u32,748u32);let mut csv=String::from("camera,x,y,w,h,full_us,roi_us,different_bytes,encode_us,coverage_bytes\n");
    for (camera,(scale,x,y)) in [(96./72.,0.,0.),(5.37,-912.25,-421.75),(0.77,17.125,-13.5)].into_iter().enumerate(){
        let matrix=scene.page_to_view(scale,x,y);let full=ctx.create_target_texture(w,h,wgpu::TextureFormat::Rgba8Unorm,None);
        let at=Instant::now();renderer.render(&ctx,&full.create_view(&Default::default()),w,h,matrix).unwrap();ctx.device.poll(wgpu::Maintain::Wait);let full_us=at.elapsed().as_micros();
        let expected=ctx.readback_texture_rgba8(&full,w,h).unwrap();
        for roi in [[0,0,130,h],[w-130,0,130,h],[0,h-92,w,92],[213,97,417,319],[0,0,3,5],[w-12,h-3,12,3]]{
            let target=ctx.create_target_texture(w,h,wgpu::TextureFormat::Rgba8Unorm,None);let at=Instant::now();
            let stats=renderer.with_prepared_region_cancellable(&ctx,&target.create_view(&Default::default()),w,h,matrix,Some(roi),&||false,|p|{ctx.queue.submit(p.commands);p.stats}).unwrap();
            ctx.device.poll(wgpu::Maintain::Wait);let roi_us=at.elapsed().as_micros();let actual=ctx.readback_texture_rgba8(&target,w,h).unwrap();
            let mut different=0;for row in roi[1]..roi[1]+roi[3]{let begin=((row*w+roi[0])*4) as usize;let end=begin+(roi[2]*4)as usize;different+=expected[begin..end].iter().zip(&actual[begin..end]).filter(|(a,b)|a!=b).count();}
            csv.push_str(&format!("{camera},{},{},{},{},{full_us},{roi_us},{different},{},{}\n",roi[0],roi[1],roi[2],roi[3],stats.encode_us,stats.coverage_bytes));
            std::fs::write(out.join("roi-parity.csv"),&csv).unwrap();assert_eq!(different,0,"camera={camera}, roi={roi:?}");
        }
    }
    println!("{csv}");
}

#[test]
fn roi_preserves_hairline_dash_clip_and_nonisolated_group(){
    use lopdf::{dictionary,Document,Stream};
    let mut doc=Document::with_version("1.7");let pages=doc.new_object_id();
    let gs=doc.add_object(dictionary!{"Type"=>"ExtGState","ca"=>0.5,"CA"=>0.7,"BM"=>"Multiply"});
    let group=doc.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),64.into(),64.into()],"Group"=>dictionary!{"S"=>"Transparency","CS"=>"DeviceCMYK","I"=>false,"K"=>false},"Resources"=>dictionary!{}},b"1 0 1 0 k 8 12 36 27 re f".to_vec()));
    let contents=doc.add_object(Stream::new(dictionary!{},b"0.2 0.8 0.1 0 k 0 0 64 64 re f q 4 4 56 56 re W n 0 0 0 1 K 0 w 2 J 0 j 7 M [3 2] 0.4 d -6 17 m 30 49 l 72 11 l S /GS gs 0 1 0 0 k 11 9 35 37 re f /G Do Q".to_vec()));
    let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),64.into(),64.into()],"Contents"=>contents,"Resources"=>dictionary!{"ExtGState"=>dictionary!{"GS"=>gs},"XObject"=>dictionary!{"G"=>group}}});
    doc.objects.insert(pages,dictionary!{"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into());let catalog=doc.add_object(dictionary!{"Type"=>"Catalog","Pages"=>pages});doc.trailer.set("Root",catalog);
    let ctx=GpuContext::new_sync().unwrap();let cm=color();let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(&cm)).unwrap());let renderer=RetainedRenderer::new(&ctx,scene.clone(),&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
    for scale in [0.73,1.1,2.3]{
        let matrix=scene.page_to_view(scale,-3.125,0.5);let full=ctx.create_target_texture(64,64,wgpu::TextureFormat::Rgba8Unorm,None);
        renderer.render(&ctx,&full.create_view(&Default::default()),64,64,matrix).unwrap();let expected=ctx.readback_texture_rgba8(&full,64,64).unwrap();
        for roi in [[0,0,13,64],[17,5,29,37],[56,44,8,20]]{
            let target=ctx.create_target_texture(64,64,wgpu::TextureFormat::Rgba8Unorm,None);
            renderer.with_prepared_region_cancellable(&ctx,&target.create_view(&Default::default()),64,64,matrix,Some(roi),&||false,|p|{ctx.queue.submit(p.commands);}).unwrap();let actual=ctx.readback_texture_rgba8(&target,64,64).unwrap();
            for row in roi[1]..roi[1]+roi[3]{let begin=((row*64+roi[0])*4)as usize;let end=begin+(roi[2]*4)as usize;assert_eq!(&actual[begin..end],&expected[begin..end],"scale={scale} roi={roi:?} row={row}");}
        }
    }
}

#[test]
fn tiny_roi_limits_nested_shared_masks_and_preserves_bc_tr_knockout(){
    use print_engine::{scene::retained::*,ink::{InkPaint,ChannelMask},content::BlendSpace,geom::{Rect,Matrix},raster::FillRule};
    let ctx=GpuContext::new_sync().unwrap();let cm=color();
    let paint=InkPaint::opaque(vec![0.3,0.1,0.2,0.],ChannelMask::PROCESS);
    let draw=|x:f32,w:f32|RetainedDraw{kind:RetainedKind::Path{path:tiny_skia::PathBuilder::from_rect(tiny_skia::Rect::from_xywh(x,0.,w,96.).unwrap()),rule:FillRule::NonZero},paint:paint.clone(),blend_space:BlendSpace::DeviceCmyk,state:Default::default()};
    let resources=Arc::new(RendererResources::new(&ctx,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap());
    for luminosity in [false,true]{for isolated in [false,true]{for knockout in [false,true]{
        let inner=Arc::new(RetainedMask{commands:vec![draw(0.,128.)],luminosity:!luminosity,
            backdrop:InkPaint{alpha:0.25,..paint.clone()},blend_space:BlendSpace::DeviceCmyk,transfer:None});
        let mut mask_draw=draw(0.,128.);mask_draw.state.mask=Some(inner);mask_draw.paint.alpha=0.7;
        let outer=Arc::new(RetainedMask{commands:vec![mask_draw],luminosity,
            backdrop:InkPaint{alpha:0.4,..paint.clone()},blend_space:BlendSpace::DeviceCmyk,
            transfer:Some((0..256).map(|v|1.-v as f32/255.).collect())});
        let mut left=draw(0.,76.);left.state.mask=Some(outer.clone());left.paint.ink=vec![1.,0.,0.,0.];
        let mut right=draw(54.,74.);right.state.mask=Some(outer);right.paint.ink=vec![0.,1.,0.,0.];
        let mut overlap=draw(42.5,33.75);overlap.paint.alpha=0.6;overlap.paint.ink=vec![0.,0.,1.,0.];
        let group=RetainedDraw{kind:RetainedKind::Group{commands:vec![right,overlap],isolated,knockout,blend_space:BlendSpace::DeviceCmyk},paint:paint.clone(),blend_space:BlendSpace::DeviceCmyk,state:Default::default()};
        let scene=Arc::new(RetainedPage{bounds:Rect::new(0.,0.,128.,96.),rotation:0,user_unit:1.,space:Default::default(),warnings:Default::default(),commands:vec![draw(0.,128.),left,group]});
        let renderer=RetainedRenderer::with_resources(&ctx,scene,resources.clone()).unwrap();
        for scale in [0.77,1.25,2.5]{
            let matrix=Matrix::new(scale,0.,0.,scale,-3.125,0.5);
            let full=ctx.create_target_texture(128,96,wgpu::TextureFormat::Rgba8Unorm,None);
            renderer.render(&ctx,&full.create_view(&Default::default()),128,96,matrix).unwrap();let expected=ctx.readback_texture_rgba8(&full,128,96).unwrap();
            for roi in [[21,17,3,5],[0,0,12,3],[80,8,37,71],[20,11,90,64]] {
                let target=ctx.create_target_texture(128,96,wgpu::TextureFormat::Rgba8Unorm,None);
                let stats=renderer.with_prepared_region_cancellable(&ctx,&target.create_view(&Default::default()),128,96,matrix,Some(roi),&||false,|p|{ctx.queue.submit(p.commands);p.stats}).unwrap();
                let actual=ctx.readback_texture_rgba8(&target,128,96).unwrap();
                for row in roi[1]..roi[1]+roi[3]{let b=((row*128+roi[0])*4)as usize;let e=b+roi[2]as usize*4;assert_eq!(&actual[b..e],&expected[b..e],"mask={luminosity}, I={isolated}, K={knockout}, scale={scale}, ROI={roi:?}");}
                if roi[2]==3{assert!(stats.masks>=2);println!("tiny ROI coverage_bytes={} draws={} masks={}",stats.coverage_bytes,stats.draws,stats.masks);assert!(stats.coverage_bytes<2048,"ROI 15 pixel không được đóng gói coverage toàn viewport: {stats:?}");}
            }
        }
    }}}
}

// Hai ảnh ở hai vùng khác nhau; kiểm material chỉ được dựng khi thật sự cần.
fn image_scene(cm:&ColorManager)->Arc<RetainedPage>{
    use lopdf::{dictionary,Document,Stream};
    let mut doc=Document::with_version("1.7");let pages=doc.new_object_id();
    let a=doc.add_object(Stream::new(dictionary!{"Subtype"=>"Image","Width"=>1,"Height"=>1,"BitsPerComponent"=>8,"ColorSpace"=>"DeviceCMYK"},vec![255,0,0,0]));
    let b=doc.add_object(Stream::new(dictionary!{"Subtype"=>"Image","Width"=>1,"Height"=>1,"BitsPerComponent"=>8,"ColorSpace"=>"DeviceCMYK"},vec![0,255,0,0]));
    let content=doc.add_object(Stream::new(dictionary!{},b"q 20 0 0 20 0 0 cm /A Do Q q 20 0 0 20 80 0 cm /B Do Q".to_vec()));
    let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),100.into(),20.into()],"Contents"=>content,"Resources"=>dictionary!{"XObject"=>dictionary!{"A"=>a,"B"=>b}}});
    doc.objects.insert(pages,dictionary!{"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into());let catalog=doc.add_object(dictionary!{"Type"=>"Catalog","Pages"=>pages});doc.trailer.set("Root",catalog);
    Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(cm)).unwrap())
}
fn color()->ColorManager {
    ColorManager::from_cmyk_profile(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc"),RenderIntent::RelativeColorimetric).unwrap()
}
#[test]
fn materials_are_lazy_and_view_scratch_is_not_shared(){
    let ctx=GpuContext::new_sync().unwrap();let cm=color();let scene=image_scene(&cm);
    let renderer=RetainedRenderer::new(&ctx,scene.clone(),&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
    assert_eq!(renderer.material_count(),0);
    let a=ctx.create_target_texture(20,20,wgpu::TextureFormat::Rgba8Unorm,None);
    let b=ctx.create_target_texture(20,20,wgpu::TextureFormat::Rgba8Unorm,None);
    let old=renderer.with_prepared(&ctx,&a.create_view(&Default::default()),20,20,scene.page_to_view(1.,0.,0.),|p|p).unwrap();
    assert_eq!(renderer.material_count(),1);
    let second=renderer.fork_for_view().unwrap();assert_eq!(second.material_count(),1);
    second.render(&ctx,&b.create_view(&Default::default()),20,20,scene.page_to_view(1.,-80.,0.)).unwrap();
    assert_eq!(renderer.material_count(),2);
    ctx.queue.submit(old.commands);
    let cyan=ctx.readback_texture_rgba8(&a,20,20).unwrap();let magenta=ctx.readback_texture_rgba8(&b,20,20).unwrap();
    let expected=cm.cmyk_to_srgb_batch(&[[1.,0.,0.,0.],[0.,1.,0.,0.]]).unwrap();
    for (pixels,want) in [(&cyan,expected[0]),(&magenta,expected[1])]{
        for got in pixels.chunks_exact(4){for ch in 0..3{assert!(got[ch].abs_diff(want[ch])<=2,"{got:?} != {want:?}");}}
    }
}
#[test]
fn resources_from_another_gpu_device_are_rejected(){
    let a=GpuContext::new_sync().unwrap();let b=GpuContext::new_sync().unwrap();let cm=color();
    let resources=Arc::new(RendererResources::new(&a,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap());
    assert!(RetainedRenderer::with_resources(&b,image_scene(&cm),resources).is_err());
}

#[test]
fn mask_buffers_recycle_after_last_use_without_overwriting_shared_masks(){
    use print_engine::{scene::retained::*,ink::{InkPaint,ChannelMask},content::BlendSpace,geom::{Rect,Matrix},raster::FillRule};
    let ctx=GpuContext::new_sync().unwrap();let cm=color();
    let path=tiny_skia::PathBuilder::from_rect(tiny_skia::Rect::from_xywh(0.,0.,16.,16.).unwrap());
    let paint=InkPaint::opaque(vec![1.,0.,0.,0.],ChannelMask::PROCESS);
    let base=||RetainedDraw{kind:RetainedKind::Path{path:path.clone(),rule:FillRule::NonZero},paint:paint.clone(),blend_space:BlendSpace::DeviceCmyk,state:Default::default()};
    let make_mask=||Arc::new(RetainedMask{commands:vec![base()],luminosity:false,backdrop:InkPaint{alpha:0.,..paint.clone()},blend_space:BlendSpace::DeviceCmyk,transfer:None});
    let shared=make_mask();let mut ds=Vec::new();
    for i in 0..40{
        let mut draw=base();draw.state.mask=Some(if i==0 || i==39{shared.clone()}else{make_mask()});
        if i!=39{draw.paint.ink=vec![0.,1.,0.,0.];}
        ds.push(draw);
    }
    let scene=Arc::new(RetainedPage{bounds:Rect::new(0.,0.,16.,16.),rotation:0,user_unit:1.,space:print_engine::ink::InkSpace::preview(),warnings:Default::default(),commands:ds});
    let renderer=RetainedRenderer::new(&ctx,scene,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
    let target=ctx.create_target_texture(16,16,wgpu::TextureFormat::Rgba8Unorm,None);
    let stats=renderer.render(&ctx,&target.create_view(&Default::default()),16,16,Matrix::IDENTITY).unwrap();
    assert_eq!(stats.masks,39);assert_eq!(stats.peak_masks,2);
    let want=cm.cmyk_to_srgb_batch(&[[1.,0.,0.,0.]]).unwrap()[0];
    for got in ctx.readback_texture_rgba8(&target,16,16).unwrap().chunks_exact(4){for ch in 0..3{assert!(got[ch].abs_diff(want[ch])<=2);}}
}

#[test]
fn repeated_clips_and_disjoint_shared_mask_keep_pixels_and_cancel_cleanly(){
    use print_engine::{scene::retained::*,ink::{InkPaint,ChannelMask},content::BlendSpace,geom::{Rect,Matrix},raster::FillRule};
    use std::sync::atomic::{AtomicUsize,Ordering};
    let ctx=GpuContext::new_sync().unwrap();let cm=color();
    let rect=|x,w|tiny_skia::PathBuilder::from_rect(tiny_skia::Rect::from_xywh(x,0.,w,32.).unwrap());
    let paint=InkPaint::opaque(vec![1.,0.,0.,0.],ChannelMask::PROCESS);
    let base=|x,w|RetainedDraw{kind:RetainedKind::Path{path:rect(x,w),rule:FillRule::NonZero},paint:paint.clone(),blend_space:BlendSpace::DeviceCmyk,state:Default::default()};
    let mask=Arc::new(RetainedMask{commands:vec![base(0.,128.)],luminosity:false,backdrop:InkPaint{alpha:0.,..paint.clone()},blend_space:BlendSpace::DeviceCmyk,transfer:None});
    let mut draws=Vec::new();
    for i in 0..80 {
        let mut d=base(if i%2==0 {0.}else{96.},32.);
        d.state.mask=Some(mask.clone());
        d.state.clip=Some(Arc::new(RetainedClip{parent:None,paths:vec![rect(0.,128.)],rule:FillRule::NonZero,stroke:None}));
        if i%2!=0 {d.paint.ink=vec![0.,1.,0.,0.];}
        draws.push(d);
    }
    let scene=Arc::new(RetainedPage{bounds:Rect::new(0.,0.,128.,32.),rotation:0,user_unit:1.,space:Default::default(),warnings:Default::default(),commands:draws});
    let renderer=RetainedRenderer::new(&ctx,scene,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
    let target=ctx.create_target_texture(128,32,wgpu::TextureFormat::Rgba8Unorm,None);
    let checks=AtomicUsize::new(0);
    let result=renderer.with_prepared_cancellable(&ctx,&target.create_view(&Default::default()),128,32,Matrix::IDENTITY,
        &||checks.fetch_add(1,Ordering::Relaxed)>12,|_|panic!("Không được submit frame đã hủy"));
    assert!(result.is_err());
    let stats=renderer.render(&ctx,&target.create_view(&Default::default()),128,32,Matrix::IDENTITY).unwrap();
    assert_eq!(stats.masks,1);assert_eq!(stats.clip_pixels,128*32,"Clip giống nhau phải chỉ raster một lần");
    let repeated=renderer.render(&ctx,&target.create_view(&Default::default()),128,32,Matrix::IDENTITY).unwrap();
    assert_eq!(repeated.clip_pixels,0,"V27: cùng camera phải dùng lại clip chính xác");assert!(repeated.clip_cache_reused>0);
    let expected=cm.cmyk_to_srgb_batch(&[[1.,0.,0.,0.],[0.,1.,0.,0.],[0.,0.,0.,0.]]).unwrap();
    for (i,pixel) in ctx.readback_texture_rgba8(&target,128,32).unwrap().chunks_exact(4).enumerate(){
        let x=i%128;let want=expected[if x<32{0}else if x>=96{1}else{2}];
        for ch in 0..3 {assert!(pixel[ch].abs_diff(want[ch])<=2,"x={x} {pixel:?} != {want:?}");}
    }
}

#[test]
fn stroke_clip_keeps_visible_paint_away_from_origin(){
    use print_engine::{scene::retained::*,ink::{InkPaint,ChannelMask},content::BlendSpace,geom::{Rect,Matrix},raster::FillRule};
    let ctx=GpuContext::new_sync().unwrap();let cm=color();
    let mut line=tiny_skia::PathBuilder::new();line.move_to(16.,0.);line.line_to(16.,32.);
    let clip=Arc::new(RetainedClip{parent:None,paths:vec![],rule:FillRule::NonZero,
        stroke:Some(RetainedClipStroke{path:line.finish().unwrap(),matrix:Matrix::IDENTITY,
            style:RetainedStroke{width:6.,cap:0,join:0,miter:10.,dash:vec![],phase:0.}})});
    let draw=RetainedDraw{kind:RetainedKind::Path{path:tiny_skia::PathBuilder::from_rect(tiny_skia::Rect::from_xywh(0.,0.,32.,32.).unwrap()),rule:FillRule::NonZero},
        paint:InkPaint::opaque(vec![1.,0.,0.,0.],ChannelMask::PROCESS),blend_space:BlendSpace::DeviceCmyk,state:RetainedState{clip:Some(clip),..Default::default()}};
    let scene=Arc::new(RetainedPage{bounds:Rect::new(0.,0.,32.,32.),rotation:0,user_unit:1.,space:Default::default(),warnings:Default::default(),commands:vec![draw]});
    let renderer=RetainedRenderer::new(&ctx,scene,&cm,wgpu::TextureFormat::Rgba8Unorm).unwrap();
    let target=ctx.create_target_texture(32,32,wgpu::TextureFormat::Rgba8Unorm,None);
    renderer.render(&ctx,&target.create_view(&Default::default()),32,32,Matrix::IDENTITY).unwrap();
    let expected=cm.cmyk_to_srgb_batch(&[[1.,0.,0.,0.],[0.,0.,0.,0.]]).unwrap();
    for (i,pixel) in ctx.readback_texture_rgba8(&target,32,32).unwrap().chunks_exact(4).enumerate(){
        let want=expected[usize::from(!(13..19).contains(&(i%32)))];
        for ch in 0..3 {assert!(pixel[ch].abs_diff(want[ch])<=2,"x={} {pixel:?} != {want:?}",i%32);}
    }
}
