//! PPE Viewer GPU - Integration Tests: Hybrid Executor & Capability Planner (Milestone G2.5)
//!
//! Kiem thu tren GPU that:
//! 1. CapabilityPlanner phan loai GpuPipeline va CpuFallback chinh xac theo gioi han hardware
//! 2. HybridGraphExecutor dieu phoi: GPU vector pass + CPU fallback upload + GPU blend + Color Resolve
//! 3. Bao toan backdrop va khong suy giam do chinh xac pixel

use viewer_gpu::{
    BlendModeGpu, CapabilityPlanner, ColorSpaceGpu, GpuBackendTarget, GpuContext,
    GroupBlendUniforms, HybridGraphExecutor, ResolveUniforms, SoftMaskTypeGpu,
};

#[test]
fn test_capability_planner_classification() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");
    let planner = CapabilityPlanner::new(&ctx);

    println!(
        "GPU Adapter: {} (Backend: {}, Max 2D Texture: {})",
        planner.adapter_name, planner.backend_name, planner.max_texture_dimension_2d
    );

    // 1. Kich thuoc binh thuong (1024x1024) -> GpuPipeline
    let (target1, reason1) = planner.plan_pass("Normal_Vector_Pass", 1024, 1024, false);
    assert_eq!(target1, GpuBackendTarget::GpuPipeline);
    assert!(reason1.is_none());

    // 2. Kich thuoc vuot nguong GPU (100,000 px) -> CpuFallback
    let (target2, reason2) = planner.plan_pass("Huge_Page_Pass", 100_000, 100_000, false);
    assert_eq!(target2, GpuBackendTarget::CpuFallback);
    assert!(reason2.is_some());
    println!(
        "Reason for huge texture fallback: {:?}",
        reason2.unwrap().reason
    );

    // 3. Primitive hiem (Tensor mesh shading) -> CpuFallback
    let (target3, reason3) = planner.plan_pass("Tensor_Mesh_Pass", 512, 512, true);
    assert_eq!(target3, GpuBackendTarget::CpuFallback);
    assert!(reason3.is_some());
    println!(
        "Reason for exotic primitive fallback: {:?}",
        reason3.unwrap().reason
    );
}

#[test]
fn test_hybrid_graph_vector_and_cpu_fallback_and_blend() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");
    let executor = HybridGraphExecutor::new(&ctx, wgpu::TextureFormat::Rgba8Unorm);

    let width = 64u32;
    let height = 64u32;

    // 1. Pass 1 (GPU Vector Path): Ve nen Cyan tren toan bo viewport
    let backdrop_surface = executor.lease_surface(&ctx, width, height, Some("Backdrop_Surface"));
    executor.execute_vector_rect(
        &ctx,
        &backdrop_surface.view,
        width,
        height,
        [0.0, 0.0, width as f32, height as f32],
        [1.0, 0.0, 0.0, 0.0], // Cyan
        true,
    );

    // 2. Pass 2 (CPU Fallback Upload): Gia lap kernel CPU da rasterize mot doi tuong phuc tap
    // (Solid Yellow C=0, M=0, Y=1, K=0) va upload len intermediate texture
    let fallback_surface = executor.lease_surface(&ctx, width, height, Some("Fallback_Surface"));
    let mut yellow_f16 = Vec::with_capacity((width * height * 8) as usize);
    let y_f16 = [
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
    ];
    for _ in 0..(width * height) {
        for b in y_f16 {
            yellow_f16.extend_from_slice(&b);
        }
    }
    executor.upload_cpu_fallback_cmyk(&ctx, &fallback_surface, width, height, &yellow_f16);

    // 3. Pass 3 (GPU Group Blend): Hoa tron Fallback vao Backdrop bang che do Multiply tren GPU
    // Cyan * Yellow trong CMYK -> Xanh la (Green: 0, 255, 0)
    let blended_surface = executor.lease_surface(&ctx, width, height, Some("Blended_Surface"));
    let blend_uniforms = GroupBlendUniforms {
        blend_mode: BlendModeGpu::Multiply as u32,
        isolated: 1,
        has_mask: 0,
        mask_type: SoftMaskTypeGpu::Alpha as u32,
        group_alpha: 1.0,
        color_space: ColorSpaceGpu::SubtractiveCmyk as u32,
        invert_mask: 0,
        _padding: 0.0,
    };

    executor.execute_group_blend(
        &ctx,
        &backdrop_surface.view,
        &fallback_surface.view,
        None,
        &blended_surface.view,
        &blend_uniforms,
    );

    // 4. Pass 4 (Color Resolve): Chuyen sang Swapchain Display Surface
    let display_target = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Display"),
    );
    let display_view = display_target.create_view(&wgpu::TextureViewDescriptor::default());

    let resolve_uniforms = ResolveUniforms {
        proof_mode: 1, // CMYK Proof mode
        overprint_sim: 0,
        gamma: 1.0,
        brightness: 1.0,
    };

    executor.execute_color_resolve(
        &ctx,
        &blended_surface.view,
        &display_view,
        &resolve_uniforms,
    );

    // 5. Doc lai pixel kiem tra
    let pixels = ctx
        .readback_texture_rgba8(&display_target, width, height)
        .expect("Readback that bai");
    let mid_pixel = &pixels[((height / 2 * width + width / 2) * 4) as usize..];
    let (r, g, b) = (mid_pixel[0], mid_pixel[1], mid_pixel[2]);

    println!("Hybrid execution result pixel: RGB=({},{},{})", r, g, b);
    assert!(r <= 10, "Red phai gan 0 (thuc te: {})", r);
    assert!(g >= 240, "Green phai sang ruc ro (thuc te: {})", g);
    assert!(b <= 10, "Blue phai gan 0 (thuc te: {})", b);

    // Kiem tra resource pool da thu hoi 3 surfaces sau khi roi khoi scope
    drop(backdrop_surface);
    drop(fallback_surface);
    drop(blended_surface);

    let stats = executor.resource_pool.stats();
    assert_eq!(
        stats.active_leases, 0,
        "Toan bo leased surface phai duoc tra ve pool"
    );
    assert_eq!(
        stats.idle_textures, 3,
        "Pool phai chua 3 intermediate textures san sang tai su dung"
    );
}

#[test]
fn pool_clear_discards_outstanding_old_epoch_lease() {
    let ctx = GpuContext::new_sync().expect("Cần GPU");
    let pool = viewer_gpu::GpuResourcePool::new();
    let old = pool.lease_intermediate(&ctx.device, 64, 64, None);
    pool.clear();
    let current = pool.lease_intermediate(&ctx.device, 64, 64, None);
    drop(old);
    assert_eq!(
        pool.stats().idle_textures,
        0,
        "Lease cũ không được hồi sinh sau clear"
    );
    drop(current);
    assert_eq!(pool.stats().idle_textures, 1);
    assert_eq!(pool.stats().active_leases, 0);
}

#[test]
fn capability_checks_format_and_zero_extent() {
    let ctx = GpuContext::new_sync().expect("Cần GPU");
    let mut planner = CapabilityPlanner::new(&ctx);
    assert!(!planner.can_support_texture_size(0, 64));
    planner.supports_rgba16f_render = false;
    assert_eq!(
        planner.plan_pass("vector", 64, 64, false).0,
        GpuBackendTarget::CpuFallback
    );
}
