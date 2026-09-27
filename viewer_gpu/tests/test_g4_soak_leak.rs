//! Kiểm tái sử dụng texture cùng kích thước; không đo HWND/VRAM hoặc soak thời gian dài.
//! PERF (audit 2026-09-25 §R25.GPU.10).

use viewer_gpu::{ColorResolvePipeline, GpuContext, GpuResourcePool, ResolveUniforms};

#[test]
fn test_1000_texture_pool_reuses() {
    let ctx = GpuContext::new_sync().expect("Cần GPU; không bỏ qua rồi báo pass");

    let pool = GpuResourcePool::new();
    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);

    let width = 1920;
    let height = 1080;

    let target_tex = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Soak_Target_Tex"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let target_view = target_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let uniforms = ResolveUniforms {
        proof_mode: 1,
        overprint_sim: 1,
        gamma: 2.2,
        brightness: 1.0,
    };

    // 1. Warm-up 10 frames de pool nap san textures
    for _ in 0..10 {
        let leased = pool.lease_intermediate(&ctx.device, width, height, Some("Soak_Warmup_Tex"));
        resolve_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &leased.view,
            &target_view,
            &uniforms,
        );
        // leased tu dong tra ve pool khi ra khoi scope (RAII)
    }

    let stats_after_warmup = pool.stats();
    let initial_total_allocations = stats_after_warmup.total_allocations;

    // 1.000 submit cùng kích thước; không tương đương 10–15 phút sử dụng.
    for _ in 0..1000 {
        let leased = pool.lease_intermediate(&ctx.device, width, height, Some("Soak_Loop_Tex"));
        resolve_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &leased.view,
            &target_view,
            &uniforms,
        );
    }

    ctx.device.poll(wgpu::Maintain::Wait);
    let stats_after_soak = pool.stats();

    // Chỉ kiểm counter pool, không suy ra VRAM/handle leak:
    // So luong texture duoc tao moi trong 1,000 frame phai bang 0 (100% tai su dung tu pool)
    let new_allocations = stats_after_soak.total_allocations - initial_total_allocations;
    assert_eq!(
        new_allocations, 0,
        "Pool tạo thêm {} texture trong soak loop!",
        new_allocations
    );

    // Kiem tra khong co texture nao bi ket (active_leases phai ve 0)
    assert_eq!(
        stats_after_soak.active_leases, 0,
        "Co texture bi ro ri/khong duoc tra ve pool sau loop: {}",
        stats_after_soak.active_leases
    );

    println!(
        "Pool reuse smoke: {} texture rảnh, {} lần tái sử dụng; chưa đo VRAM/HWND.",
        stats_after_soak.idle_textures, stats_after_soak.pool_reuses
    );
}
