//! PPE Viewer GPU - Integration Tests: Image Sampling & Resource Pool (Milestone G2.4)
//!
//! Kiem thu tren GPU that:
//! 1. Ve anh CMYK voi affine transform CTM len intermediate surface
//! 2. Ve Image Mask 1-kenh to mau tint CMYK
//! 3. Resource Pool cap phat, cho muon (lease), tu dong tai su dung (RAII recycle)

use viewer_gpu::{
    ColorResolvePipeline, GpuContext, GpuResourcePool, ImageSamplePipeline, ImageUniforms,
    ResolveUniforms,
};

#[test]
fn test_gpu_image_cmyk_sampling_and_affine_transform() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

    let img_w = 32u32;
    let img_h = 32u32;
    let target_w = 64u32;
    let target_h = 64u32;

    // 1. Tao image texture 32x32 chua du lieu CMYK
    // Nua tren: Solid Cyan (C=1, M=0, Y=0, K=0)
    // Nua duoi: Solid Yellow (C=0, M=0, Y=1, K=0)
    let mut img_f16 = Vec::with_capacity((img_w * img_h * 8) as usize);
    let cyan_f16 = [
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
    ];
    let yellow_f16 = [
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
    ];
    for y in 0..img_h {
        for _x in 0..img_w {
            let sample = if y < img_h / 2 { cyan_f16 } else { yellow_f16 };
            for b in sample {
                img_f16.extend_from_slice(&b);
            }
        }
    }

    let img_tex = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Test_Source_Image"),
        size: wgpu::Extent3d {
            width: img_w,
            height: img_h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &img_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &img_f16,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(img_w * 8),
            rows_per_image: Some(img_h),
        },
        wgpu::Extent3d {
            width: img_w,
            height: img_h,
            depth_or_array_layers: 1,
        },
    );

    let target_tex = ctx.create_intermediate_texture(target_w, target_h, Some("Target_Image_Render"));
    let img_view = img_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let target_view = target_tex.create_view(&wgpu::TextureViewDescriptor::default());

    // 2. Ma tran CTM bien doi quad [0, 1]x[0, 1] sang toan bo viewport NDC [-1, 1]x[-1, 1]
    // Column-major mat4:
    // col 0: [2.0, 0.0, 0.0, 0.0]
    // col 1: [0.0, -2.0, 0.0, 0.0]
    // col 2: [0.0, 0.0, 1.0, 0.0]
    // col 3: [-1.0, 1.0, 0.0, 1.0]
    let ctm = [
        2.0, 0.0, 0.0, 0.0,
        0.0, -2.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        -1.0, 1.0, 0.0, 1.0,
    ];

    let image_pipeline = ImageSamplePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let uniforms = ImageUniforms {
        transform_matrix: ctm,
        tint_cmyk: [0.0, 0.0, 0.0, 0.0],
        color_type: 0, // CMYK
        has_alpha: 0,
        alpha: 1.0,
        _padding: 0.0,
    };

    image_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &img_view,
        &target_view,
        &uniforms,
        true, // Linear interpolation
    );

    // 3. Resolve sang Display Target va doc lai pixel
    let display_target = ctx.create_target_texture(target_w, target_h, wgpu::TextureFormat::Rgba8Unorm, Some("Display"));
    let display_view = display_target.create_view(&wgpu::TextureViewDescriptor::default());

    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);
    let resolve_uniforms = ResolveUniforms {
        proof_mode: 1, // Proof mode CMYK -> sRGB
        overprint_sim: 0,
        gamma: 1.0,
        brightness: 1.0,
    };

    resolve_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &target_view,
        &display_view,
        &resolve_uniforms,
    );

    let pixels = ctx.readback_texture_rgba8(&display_target, target_w, target_h).expect("Readback that bai");

    // Nua tren (y = 10): Cyan -> RGB (0, 255, 255)
    let top_idx = ((10 * target_w + 32) * 4) as usize;
    let (tr, tg, tb) = (pixels[top_idx], pixels[top_idx + 1], pixels[top_idx + 2]);

    // Nua duoi (y = 50): Yellow -> RGB (255, 255, 0)
    let bot_idx = ((50 * target_w + 32) * 4) as usize;
    let (br, bg, bb) = (pixels[bot_idx], pixels[bot_idx + 1], pixels[bot_idx + 2]);

    println!("Image sampling test: Top RGB=({},{},{}), Bot RGB=({},{},{})", tr, tg, tb, br, bg, bb);
    assert!(tr <= 10 && tg >= 240 && tb >= 240, "Top phai la Cyan (0,255,255), thuc te: ({},{},{})", tr, tg, tb);
    assert!(br >= 240 && bg >= 240 && bb <= 10, "Bot phai la Yellow (255,255,0), thuc te: ({},{},{})", br, bg, bb);
}

#[test]
fn test_gpu_image_mask_tinting() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

    let mask_w = 32u32;
    let mask_h = 32u32;
    let target_w = 64u32;
    let target_h = 64u32;

    // Tao 1-channel mask texture (Rgba16Float):
    // Nua trai: Coverage = 0.0
    // Nua phai: Coverage = 1.0
    let mut mask_f16 = Vec::with_capacity((mask_w * mask_h * 8) as usize);
    let zero_f16 = [
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
    ];
    let one_f16 = [
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
    ];
    for _y in 0..mask_h {
        for x in 0..mask_w {
            let sample = if x < mask_w / 2 { zero_f16 } else { one_f16 };
            for b in sample {
                mask_f16.extend_from_slice(&b);
            }
        }
    }

    let mask_tex = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Test_Mask_Texture"),
        size: wgpu::Extent3d {
            width: mask_w,
            height: mask_h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &mask_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &mask_f16,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(mask_w * 8),
            rows_per_image: Some(mask_h),
        },
        wgpu::Extent3d {
            width: mask_w,
            height: mask_h,
            depth_or_array_layers: 1,
        },
    );

    let target_tex = ctx.create_intermediate_texture(target_w, target_h, Some("Target_Mask_Tint"));
    let mask_view = mask_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let target_view = target_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let ctm = [
        2.0, 0.0, 0.0, 0.0,
        0.0, -2.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        -1.0, 1.0, 0.0, 1.0,
    ];

    let image_pipeline = ImageSamplePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    // Tint Magenta: C=0, M=1.0, Y=0, K=0
    let uniforms = ImageUniforms {
        transform_matrix: ctm,
        tint_cmyk: [0.0, 1.0, 0.0, 0.0],
        color_type: 2, // Image Mask
        has_alpha: 0,
        alpha: 1.0,
        _padding: 0.0,
    };

    image_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &mask_view,
        &target_view,
        &uniforms,
        false, // Nearest
    );

    let display_target = ctx.create_target_texture(target_w, target_h, wgpu::TextureFormat::Rgba8Unorm, Some("Display"));
    let display_view = display_target.create_view(&wgpu::TextureViewDescriptor::default());

    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);
    let resolve_uniforms = ResolveUniforms {
        proof_mode: 1,
        overprint_sim: 0,
        gamma: 1.0,
        brightness: 1.0,
    };

    resolve_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &target_view,
        &display_view,
        &resolve_uniforms,
    );

    let pixels = ctx.readback_texture_rgba8(&display_target, target_w, target_h).expect("Readback that bai");

    // Nua trai (x = 10): Mask = 0.0 -> Khong co muc -> White (255, 255, 255)
    let left_idx = ((32 * target_w + 10) * 4) as usize;
    let (lr, lg, lb) = (pixels[left_idx], pixels[left_idx + 1], pixels[left_idx + 2]);

    // Nua phai (x = 50): Mask = 1.0 -> Tint Magenta -> RGB (255, 0, 255)
    let right_idx = ((32 * target_w + 50) * 4) as usize;
    let (rr, rg, rb) = (pixels[right_idx], pixels[right_idx + 1], pixels[right_idx + 2]);

    println!("Mask tint test: Left RGB=({},{},{}), Right RGB=({},{},{})", lr, lg, lb, rr, rg, rb);
    assert!(lr >= 250 && lg >= 250 && lb >= 250, "Left phai la White (255,255,255), thuc te: ({},{},{})", lr, lg, lb);
    assert!(rr >= 240 && rg <= 10 && rb >= 240, "Right phai la Magenta (255,0,255), thuc te: ({},{},{})", rr, rg, rb);
}

#[test]
fn test_gpu_resource_pool_lease_and_recycle() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");
    let pool = GpuResourcePool::new();

    // 1. Lan muon dau tien: phai allocate moi
    {
        let t1 = pool.lease_intermediate(&ctx.device, 128, 128, Some("Lease_1"));
        assert_eq!(t1.width, 128);
        assert_eq!(t1.height, 128);

        let stats = pool.stats();
        assert_eq!(stats.total_allocations, 1);
        assert_eq!(stats.total_leases, 1);
        assert_eq!(stats.active_leases, 1);
        assert_eq!(stats.idle_textures, 0);
    } // t1 drop o day -> tu dong tra ve pool

    // 2. Kiem tra stats sau khi drop: idle_textures = 1, active_leases = 0
    let stats_after_drop = pool.stats();
    assert_eq!(stats_after_drop.total_allocations, 1);
    assert_eq!(stats_after_drop.active_leases, 0);
    assert_eq!(stats_after_drop.idle_textures, 1);

    // 3. Lan muon thu 2 voi cung kich thuoc (128x128): phai reuse, KHONG allocate moi!
    {
        let t2 = pool.lease_intermediate(&ctx.device, 128, 128, Some("Lease_2"));
        assert_eq!(t2.width, 128);
        assert_eq!(t2.height, 128);

        let stats = pool.stats();
        assert_eq!(stats.total_allocations, 1, "Tong allocation khong duoc tang khi reuse");
        assert_eq!(stats.total_leases, 2);
        assert_eq!(stats.pool_reuses, 1, "Pool phai ghi nhan 1 lan tai su dung");
        assert_eq!(stats.active_leases, 1);
        assert_eq!(stats.idle_textures, 0);
    } // t2 drop

    // 4. Muon kich thuoc khac (256x256): phai allocate them 1 texture moi
    {
        let t3 = pool.lease_intermediate(&ctx.device, 256, 256, Some("Lease_3"));
        assert_eq!(t3.width, 256);
        assert_eq!(t3.height, 256);

        let stats = pool.stats();
        assert_eq!(stats.total_allocations, 2);
        assert_eq!(stats.total_leases, 3);
        assert_eq!(stats.active_leases, 1);
    } // t3 drop

    // Bay gio pool co 2 idle textures (128x128 va 256x256)
    assert_eq!(pool.stats().idle_textures, 2);

    // 5. Test clear pool
    pool.clear();
    assert_eq!(pool.stats().idle_textures, 0);
}
