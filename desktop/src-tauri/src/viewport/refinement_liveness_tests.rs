//! PERF (audit 2026-09-27 §V27.R4): dùng policy production + cache + Refiner
//! thật, không tạo cửa sổ/input. Fence/readback chỉ ở test, không trong UI.
use super::super::{
    detail_cache::DetailCache,
    document_renderer::DocumentRenderer,
    presenter::policy::{RefinementDecision, RefinementPolicy},
};
use super::*;
use print_engine::{content::RenderOptions, scene::retained::RetainedPage};
use std::time::{Duration, Instant};
use viewer_gpu::retained_renderer::RetainedRenderer;
use viewer_gpu::resident_present::{ResidentCompositor, ResidentFrame};

fn exercise(
    scene: Arc<RetainedPage>,
    width: u32,
    height: u32,
    verify_pixels: bool,
    format: wgpu::TextureFormat,
) -> serde_json::Value {
    let ctx = Arc::new(GpuContext::new_sync().unwrap());
    let color = super::super::scene_worker::color_manager().unwrap();
    let gpu = Arc::new(
        RetainedRenderer::new(&ctx, scene.clone(), &color, format)
            .unwrap(),
    );
    // Renderer đối chứng riêng: không tranh mutex pool với Refiner đang đợi ACK.
    let reference =
        RetainedRenderer::new(&ctx, scene.clone(), &color, format)
            .unwrap();
    let renderer = Arc::new(DocumentRenderer::gpu(gpu));
    let (wake, _) = mpsc::sync_channel(1);
    let worker = Refiner::new(
        ctx.clone(),
        format,
        Arc::new(AtomicBool::new(false)),
        wake,
        Arc::new(AtomicU64::new(1)),
    )
    .unwrap();
    let mut cache = DetailCache::new(None);
    let mut policy = RefinementPolicy::default();
    let fit = (width as f32 / scene.bounds.width()).min(height as f32 / scene.bounds.height());
    let overview_matrix=scene.page_to_view(fit,0.,0.);
    let overview_texture=ctx.create_target_texture(width,height,format,None);
    reference.render(&ctx,&overview_texture.create_view(&Default::default()),width,height,overview_matrix).unwrap();
    let overview=ResidentFrame{texture:overview_texture,matrix:overview_matrix};
    let compositor=ResidentCompositor::new(&ctx,format);
    let mut rows = Vec::new();
    let mut recoveries = 0;
    let mut idle_checks = 0;
    for dpr in [1., 1.25, 1.5, 2.] {
        for (index, (factor, dx, dy)) in [
            (1., 0., 0.),
            (4.5, 0.25, 0.75),
            (4.5, -5.1, 4.5),
            (4.5, -9.35, 5.25),
            (1.35, 0.35, -0.75),
            (4.5, 0.25, 0.75),
            (4.5, -5.1, 4.5),
            (1., 0., 0.),
        ]
        .into_iter()
        .enumerate()
        {
            let zoom = fit * factor;
            let camera = CameraSnapshot {
                zoom,
                pan_x: -((scene.bounds.width() * zoom - width as f32 / dpr) * 0.5).max(0.) + dx,
                pan_y: -((scene.bounds.height() * zoom - height as f32 / dpr) * 0.5).max(0.) + dy,
                dpr,
                viewport_width: width,
                viewport_height: height,
            };
            let matrix = scene.page_to_view(zoom * dpr, camera.pan_x * dpr, camera.pan_y * dpr);
            let mut passes = 0;
            let mut render_us = 0;
            let mut encode_us = 0;
            let mut different_bytes = 0;
            let expected = if verify_pixels {
                let full =
                    ctx.create_target_texture(width, height, format, None);
                reference
                    .render(
                        &ctx,
                        &full.create_view(&Default::default()),
                        width,
                        height,
                        matrix,
                    )
                    .unwrap();
                Some(ctx.readback_texture_rgba8(&full, width, height).unwrap())
            } else {
                None
            };
            let started = Instant::now();
            loop {
                let decision = policy.plan(
                    &mut cache,
                    matrix,
                    width,
                    height,
                    renderer.supports_partial_refinement(),
                );
                let RefinementDecision::Render { region, recovering } = decision else {
                    break;
                };
                assert!(
                    passes < 16,
                    "Refinement không hội tụ: dpr={dpr}, index={index}, entries={}",
                    cache.len()
                );
                recoveries += usize::from(recovering);
                let at = Instant::now();
                worker.submit(RefineRequest {
                    frame: FrameRequest {
                        camera,
                        renderer: Some(renderer.clone()),
                        revision: 1,
                        at,
                        notify: None,
                        input: None,
                        overlays: vec![],
                    },
                    overview: false,
                    generation: 0,
                    region,
                });
                let work = worker
                    .receive
                    .recv_timeout(Duration::from_secs(20))
                    .unwrap()
                    .unwrap();
                assert!(work.stats.content_proof.is_verified());
                encode_us += work.stats.encode_us;
                ctx.queue.submit(work.commands);
                ctx.device.poll(wgpu::Maintain::Wait);
                render_us += at.elapsed().as_micros();
                if let Some(expected) = &expected {
                    let [x, y, w, h] = work.coverage.rect;
                    let actual = ctx
                        .readback_texture_rgba8(&work.frame.texture, w, h)
                        .unwrap();
                    for row in 0..h {
                        let offset = ((y + row) * width + x) as usize * 4;
                        let local = (row * w) as usize * 4;
                        different_bytes += expected[offset..offset + w as usize * 4]
                            .iter()
                            .zip(&actual[local..local + w as usize * 4])
                            .filter(|(a, b)| a != b)
                            .count();
                    }
                }
                cache.insert_with_coverage(work.frame, work.coverage);
                work.done.send(()).unwrap();
                passes += 1;
            }
            let total_us = started.elapsed().as_micros();
            assert_eq!(
                different_bytes, 0,
                "ROI khác full-frame tại dpr={dpr}, camera={index}"
            );
            // R8: kết quả sau compositor mới là pixel sẽ đi tới surface.
            // Texture ROI đúng không đủ nếu một layer cũ vẫn che nó.
            let composed_different_bytes=if let Some(expected)=&expected{
                let composed=ctx.create_target_texture(width,height,format,None);
                let mut commands=ctx.device.create_command_encoder(&Default::default());
                compositor.encode_layers(&ctx,&mut commands,&composed.create_view(&Default::default()),matrix,&overview,&cache.frames(),width,height).unwrap();
                ctx.queue.submit([commands.finish()]);
                let actual=ctx.readback_texture_rgba8(&composed,width,height).unwrap();
                actual.iter().zip(expected).filter(|(a,b)|a!=b).count()
            }else{0};
            assert_eq!(composed_different_bytes,0,"Pixel cuối chưa khớp camera: format={format:?}, dpr={dpr}, index={index}");
            // Đứng yên: production policy không phát thêm bất kỳ yêu cầu nào.
            for _ in 0..120 {
                assert_eq!(
                    policy.plan(&mut cache, matrix, width, height, true),
                    RefinementDecision::Idle
                );
                idle_checks += 1;
            }
            assert!(worker.receive.try_recv().is_err());
            rows.push(serde_json::json!({"dpr":dpr,"index":index,"zoom":zoom,"pan":[camera.pan_x,camera.pan_y],
                "refinements":passes,"entries":cache.len(),"cpu_encode_us":encode_us,"render_fence_us":render_us,
                "converged_us_with_pixel_checks":total_us,"different_bytes":different_bytes,"composed_different_bytes":composed_different_bytes}));
        }
    }
    assert_eq!(
        recoveries, 0,
        "Dữ liệu bình thường phải hội tụ mà không cần full recovery"
    );
    serde_json::json!({"headless":true,"displayed":"unobserved","shared_production_policy":true,
        "native_surface_and_gpu_batch_scheduler":false,"final_compositor_checked":true,"format":format!("{format:?}"),"size":[width,height],"idle_checks":idle_checks,"recoveries":recoveries,"samples":rows})
}

#[test]
fn fractional_pan_zoom_refiner_converges_then_stays_idle() {
    use lopdf::{dictionary, Document, Stream};
    let mut doc = Document::with_version("1.7");
    let pages = doc.new_object_id();
    let data = doc.add_object(Stream::new(
        dictionary! {},
        b"1 0 0 0 k 0 0 64 48 re f 0 1 0 0 k 7 5 33 21 re f".to_vec(),
    ));
    let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),64.into(),48.into()],"Contents"=>data,"Resources"=>dictionary!{}});
    doc.objects.insert(
        pages,
        dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into(),
    );
    let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
    doc.trailer.set("Root", cat);
    let color = super::super::scene_worker::color_manager().unwrap();
    let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(&color)).unwrap());
    for format in [wgpu::TextureFormat::Rgba8Unorm,wgpu::TextureFormat::Bgra8UnormSrgb]{
        let result=exercise(scene.clone(),64,48,true,format);println!("LIVENESS {result}");
    }
}

#[test]
#[ignore = "Headless PDF thật: PRYNX_V27_REGRESSION_PDF, PRYNX_V27_REGRESSION_OUT"]
fn real_pdf_fractional_refinement_converges_then_stays_idle() {
    use sha2::{Digest, Sha256};
    let path = std::env::var("PRYNX_V27_REGRESSION_PDF").unwrap();
    let out = std::path::PathBuf::from(std::env::var("PRYNX_V27_REGRESSION_OUT").unwrap());
    assert!(!out.exists(), "Không ghi đè bằng chứng trước");
    let bytes = std::fs::read(&path).unwrap();
    let input_sha = format!("{:x}", Sha256::digest(&bytes));
    let doc = lopdf::Document::load_mem(&bytes).unwrap();
    let color = super::super::scene_worker::color_manager().unwrap();
    let scene =
        Arc::new(RetainedPage::compile(&doc, 1, RenderOptions::viewer(), Some(&color)).unwrap());
    let format=if std::env::var("PRYNX_V27_FORMAT").as_deref()==Ok("bgra-srgb"){wgpu::TextureFormat::Bgra8UnormSrgb}else{wgpu::TextureFormat::Rgba8Unorm};
    let mut result = exercise(scene, 1292, 733, true,format);
    result["pdf"] = path.into();
    result["page"] = 1.into();
    result["input_sha256"] = input_sha.into();
    std::fs::write(&out, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    println!("{}", out.display());
}
