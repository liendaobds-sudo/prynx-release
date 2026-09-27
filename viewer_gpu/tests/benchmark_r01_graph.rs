//! Microbenchmark cảnh tổng hợp (rectangle/Bezier), không đọc PDF R01.
//! Tổng frame có đợi GPU; stage chỉ đo CPU encode/submit, không phải GPU timestamp.
//! PERF (audit 2026-09-25 §R25.GPU.10).

use std::fs;
use std::path::Path;
use std::time::Instant;
use viewer_gpu::{
    BlendModeGpu, ColorResolvePipeline, ColorSpaceGpu, GpuContext, GroupBlendPipeline,
    GroupBlendUniforms, ImageSamplePipeline, ImageUniforms, PathRasterPipeline, PathUniforms,
    ResolveUniforms, SoftMaskPipeline, SoftMaskTypeGpu, SoftMaskUniforms,
};

#[test]
fn test_benchmark_synthetic_gpu_pipeline() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

    let width = 1024u32;
    let height = 1024u32;

    // 1. Khoi tao cac pipeline GPU
    let raster_pipeline = PathRasterPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let image_pipeline = ImageSamplePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let mask_pipeline = SoftMaskPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let blend_pipeline =
        GroupBlendPipeline::new(&ctx.device, &ctx.queue, wgpu::TextureFormat::Rgba16Float);
    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);

    // 2. Cap phat intermediate textures
    let surface_backdrop = ctx.create_intermediate_texture(width, height, Some("Bench_Backdrop"));
    let surface_source = ctx.create_intermediate_texture(width, height, Some("Bench_Source"));
    let surface_mask = ctx.create_intermediate_texture(width, height, Some("Bench_Mask"));
    let surface_blended = ctx.create_intermediate_texture(width, height, Some("Bench_Blended"));
    let surface_display = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Bench_Display"),
    );

    let view_backdrop = surface_backdrop.create_view(&wgpu::TextureViewDescriptor::default());
    let view_source = surface_source.create_view(&wgpu::TextureViewDescriptor::default());
    let view_mask = surface_mask.create_view(&wgpu::TextureViewDescriptor::default());
    let view_blended = surface_blended.create_view(&wgpu::TextureViewDescriptor::default());
    let view_display = surface_display.create_view(&wgpu::TextureViewDescriptor::default());

    // 3. Chuan bi du lieu mau
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    viewer_gpu::push_rect_vertices(
        &mut vertices,
        &mut indices,
        50.0,
        50.0,
        900.0,
        900.0,
        [0.0, 0.8, 0.8, 0.0],
        1.0,
    );
    viewer_gpu::push_quadratic_bezier_vertices(
        &mut vertices,
        &mut indices,
        (100.0, 100.0),
        (500.0, 800.0),
        (900.0, 100.0),
        [0.8, 0.0, 0.5, 0.0],
        1.0,
    );

    let path_uniforms = PathUniforms {
        viewport_width: width as f32,
        viewport_height: height as f32,
        device_scale: 1.0,
        _pad: 0.0,
    };

    let img_uniforms = ImageUniforms {
        transform_matrix: [
            2.0, 0.0, 0.0, 0.0, 0.0, -2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0,
        ],
        tint_cmyk: [0.0, 0.0, 0.0, 0.0],
        color_type: 0,
        has_alpha: 0,
        alpha: 1.0,
        _padding: 0.0,
    };

    let mask_uniforms = SoftMaskUniforms {
        mask_type: SoftMaskTypeGpu::Alpha as u32,
        color_space: 2, // Scalar coverage riêng cho microbenchmark
        invert: 0,
        backdrop_lum: 1.0,
    };

    let blend_uniforms = GroupBlendUniforms {
        blend_mode: BlendModeGpu::Multiply as u32,
        isolated: 1,
        has_mask: 1,
        mask_type: SoftMaskTypeGpu::Luminosity as u32,
        group_alpha: 1.0,
        color_space: ColorSpaceGpu::SubtractiveCmyk as u32,
        invert_mask: 0,
        _padding: 0.0,
    };

    let resolve_uniforms = ResolveUniforms {
        proof_mode: 1,
        overprint_sim: 1,
        gamma: 2.2,
        brightness: 1.0,
    };

    // 4. Warm-up 10 vong de khoi tao shader compilation & pipeline state tren GPU driver
    for _ in 0..10 {
        raster_pipeline.render(
            &ctx.device,
            &ctx.queue,
            &view_backdrop,
            &vertices,
            &indices,
            &path_uniforms,
            true,
        );
        image_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &view_backdrop,
            &view_source,
            &img_uniforms,
            true,
        );
        mask_pipeline
            .execute(
                &ctx.device,
                &ctx.queue,
                &view_source,
                &view_mask,
                &mask_uniforms,
            )
            .expect("Scalar mask hợp lệ");
        blend_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &view_backdrop,
            &view_source,
            Some(&view_mask),
            &view_blended,
            &blend_uniforms,
        );
        resolve_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &view_blended,
            &view_display,
            &resolve_uniforms,
        );
    }
    let _ = ctx.device.poll(wgpu::MaintainBase::Wait);

    // 5. Benchmark 100 luot do dac thuc te
    let iterations = 100;
    let mut total_times_ms = Vec::with_capacity(iterations);
    let mut stage_raster_ms = Vec::with_capacity(iterations);
    let mut stage_blend_ms = Vec::with_capacity(iterations);
    let mut stage_resolve_ms = Vec::with_capacity(iterations);

    for _ in 0..iterations {
        let t_frame_start = Instant::now();

        let t0 = Instant::now();
        raster_pipeline.render(
            &ctx.device,
            &ctx.queue,
            &view_backdrop,
            &vertices,
            &indices,
            &path_uniforms,
            true,
        );
        let t_raster = t0.elapsed().as_secs_f64() * 1000.0;

        image_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &view_backdrop,
            &view_source,
            &img_uniforms,
            true,
        );
        mask_pipeline
            .execute(
                &ctx.device,
                &ctx.queue,
                &view_source,
                &view_mask,
                &mask_uniforms,
            )
            .expect("Scalar mask hợp lệ");

        let t1 = Instant::now();
        blend_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &view_backdrop,
            &view_source,
            Some(&view_mask),
            &view_blended,
            &blend_uniforms,
        );
        let t_blend = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        resolve_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &view_blended,
            &view_display,
            &resolve_uniforms,
        );
        let t_resolve = t2.elapsed().as_secs_f64() * 1000.0;

        let _ = ctx.device.poll(wgpu::MaintainBase::Wait);
        let t_frame = t_frame_start.elapsed().as_secs_f64() * 1000.0;

        total_times_ms.push(t_frame);
        stage_raster_ms.push(t_raster);
        stage_blend_ms.push(t_blend);
        stage_resolve_ms.push(t_resolve);
    }

    // Helper tinh percentile
    fn percentile(values: &mut [f64], pct: f64) -> f64 {
        values.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let idx =
            ((values.len() as f64) * pct / 100.0).clamp(0.0, (values.len() - 1) as f64) as usize;
        values[idx]
    }

    let p50_frame = percentile(&mut total_times_ms.clone(), 50.0);
    let p95_frame = percentile(&mut total_times_ms.clone(), 95.0);
    let p99_frame = percentile(&mut total_times_ms.clone(), 99.0);

    let p50_raster = percentile(&mut stage_raster_ms.clone(), 50.0);
    let p95_raster = percentile(&mut stage_raster_ms.clone(), 95.0);

    let p50_blend = percentile(&mut stage_blend_ms.clone(), 50.0);
    let p95_blend = percentile(&mut stage_blend_ms.clone(), 95.0);

    let p50_resolve = percentile(&mut stage_resolve_ms.clone(), 50.0);
    let p95_resolve = percentile(&mut stage_resolve_ms.clone(), 95.0);

    println!("=== KET QUA BENCHMARK GPU PIPELINE (1024x1024, 100 runs) ===");
    println!(
        "Total Frame:   p50 = {:.3} ms | p95 = {:.3} ms | p99 = {:.3} ms",
        p50_frame, p95_frame, p99_frame
    );
    println!(
        "Raster Pass:   p50 = {:.3} ms | p95 = {:.3} ms",
        p50_raster, p95_raster
    );
    println!(
        "Blend Pass:    p50 = {:.3} ms | p95 = {:.3} ms",
        p50_blend, p95_blend
    );
    println!(
        "Resolve Pass:  p50 = {:.3} ms | p95 = {:.3} ms",
        p50_resolve, p95_resolve
    );

    // Kiem tra tieu chi P01: Frame work <= 16.7 ms (60 Hz)
    assert!(
        p95_frame <= 16.7,
        "P01 vi pham: p95 frame work vuot qua 16.7 ms ({:.3} ms)",
        p95_frame
    );
    // Kiem tra Color Resolve Pass: phai cuc nhe <= 2.0 ms
    assert!(
        p95_resolve <= 2.0,
        "Color Resolve Pass qua cham ({:.3} ms)",
        p95_resolve
    );

    let json_content = format!(
        r#"{{
  "evidence_kind": "synthetic_graph",
  "runtime_acceptance": "UNOBSERVED",
  "gpu_adapter": "{}",
  "texture_width": {},
  "texture_height": {},
  "iterations": {},
  "frame_p50_ms": {:.4},
  "frame_p95_ms": {:.4},
  "frame_p99_ms": {:.4},
  "cpu_submit_raster_p95_ms": {:.4},
  "cpu_submit_blend_p95_ms": {:.4},
  "cpu_submit_resolve_p95_ms": {:.4},
  "verdict": "MICROBENCHMARK_ONLY"
}}"#,
        ctx.adapter_info.name,
        width,
        height,
        iterations,
        p50_frame,
        p95_frame,
        p99_frame,
        p95_raster,
        p95_blend,
        p95_resolve
    );

    // Ghi ket qua JSON ve ca thu muc goc repo va thu muc crate
    let root_path = Path::new("..").join(".tmp/viewer-gpu/runs/latest");
    let local_path = Path::new(".tmp/viewer-gpu/runs/latest");
    let _ = fs::create_dir_all(&root_path);
    let _ = fs::create_dir_all(&local_path);
    let _ = fs::write(root_path.join("benchmark_g2.json"), &json_content);
    let _ = fs::write(local_path.join("benchmark_g2.json"), &json_content);
    println!("Da ghi ket qua benchmark tai: benchmark_g2.json");
}
