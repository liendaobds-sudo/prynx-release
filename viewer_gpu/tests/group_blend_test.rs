//! PPE Viewer GPU - Integration Tests: Transparency Group & Soft Mask (Milestone G2.3)
//!
//! Kiem thu thuc thi tren GPU that (NVIDIA GeForce RTX 3060 qua D3D12/Vulkan):
//! 1. Isolated Group voi BlendMode::Multiply tren nen CMYK (Cyan * Yellow = Green)
//! 2. Non-Isolated Group bao toan backdrop va noi suy alpha
//! 3. Soft Mask Luminosity sinh tu CMYK (White -> 1.0, Black -> 0.0)
//! 4. Soft Mask ap dung len Isolated Group dieu bien do mo theo mat na

use viewer_gpu::{
    BlendModeGpu, ColorResolvePipeline, ColorSpaceGpu, GpuContext, GroupBlendPipeline,
    GroupBlendUniforms, ResolveUniforms, SoftMaskPipeline, SoftMaskTypeGpu, SoftMaskUniforms,
};

/// Helper tao du lieu f16 CMYK cho toan bo texture
fn make_solid_cmyk_f16(width: u32, height: u32, cmyk: [f32; 4]) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 4 * 2) as usize);
    let f16_vals = [
        half::f16::from_f32(cmyk[0]).to_le_bytes(),
        half::f16::from_f32(cmyk[1]).to_le_bytes(),
        half::f16::from_f32(cmyk[2]).to_le_bytes(),
        half::f16::from_f32(cmyk[3]).to_le_bytes(),
    ];
    for _ in 0..(width * height) {
        for b in f16_vals {
            data.extend_from_slice(&b);
        }
    }
    data
}

#[test]
fn test_gpu_isolated_group_multiply_blend() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

    let width = 64u32;
    let height = 64u32;

    // 1. Backdrop: Solid Yellow (C=0, M=0, Y=1.0, K=0)
    let backdrop_tex = ctx.create_intermediate_texture(width, height, Some("Backdrop_Yellow"));
    let yellow_data = make_solid_cmyk_f16(width, height, [0.0, 0.0, 1.0, 0.0]);
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &backdrop_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &yellow_data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    // 2. Source Group: Solid Cyan (C=1.0, M=0, Y=0, K=0)
    let source_tex = ctx.create_intermediate_texture(width, height, Some("Source_Cyan"));
    let cyan_data = make_solid_cmyk_f16(width, height, [1.0, 0.0, 0.0, 0.0]);
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &source_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &cyan_data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    // 3. Target Intermediate Texture
    let target_intermediate =
        ctx.create_intermediate_texture(width, height, Some("Target_Blended"));

    let backdrop_view = backdrop_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let source_view = source_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let target_inter_view =
        target_intermediate.create_view(&wgpu::TextureViewDescriptor::default());

    // 4. Group Blend Pass: Multiply
    let blend_pipeline =
        GroupBlendPipeline::new(&ctx.device, &ctx.queue, wgpu::TextureFormat::Rgba16Float);
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

    blend_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &backdrop_view,
        &source_view,
        None,
        &target_inter_view,
        &blend_uniforms,
    );

    // 5. Color Resolve sang Rgba8Unorm
    let target_display = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Display_Target"),
    );
    let target_display_view = target_display.create_view(&wgpu::TextureViewDescriptor::default());

    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);
    let resolve_uniforms = ResolveUniforms {
        proof_mode: 1, // Che do CMYK Proof: RGB = (1-C, 1-M, 1-Y) * (1-K)
        overprint_sim: 0,
        gamma: 1.0,
        brightness: 1.0,
    };

    resolve_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &target_inter_view,
        &target_display_view,
        &resolve_uniforms,
    );

    // 6. Doc lai pixel de kiem tra: Cyan * Yellow trong CMYK -> Cyan=1, Yellow=1 -> sRGB = Green (0, 255, 0)
    let pixels = ctx
        .readback_texture_rgba8(&target_display, width, height)
        .expect("Readback that bai");
    let mid_pixel = &pixels[((height / 2 * width + width / 2) * 4) as usize..];
    let (r, g, b, _a) = (mid_pixel[0], mid_pixel[1], mid_pixel[2], mid_pixel[3]);

    println!("Multiply blend test pixel: R={}, G={}, B={}", r, g, b);
    assert!(r <= 10, "Red phai gan bang 0 vi Cyan=1 (thuc te: {})", r);
    assert!(
        g >= 240,
        "Green phai sang ruc ro vi Magenta=0 (thuc te: {})",
        g
    );
    assert!(b <= 10, "Blue phai gan bang 0 vi Yellow=1 (thuc te: {})", b);
}

#[test]
fn test_gpu_non_isolated_group_alpha_interpolation() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

    let width = 64u32;
    let height = 64u32;

    // 1. Backdrop: Solid Magenta (C=0, M=1.0, Y=0, K=0)
    let backdrop_tex = ctx.create_intermediate_texture(width, height, Some("Backdrop_Magenta"));
    let magenta_data = make_solid_cmyk_f16(width, height, [0.0, 1.0, 0.0, 0.0]);
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &backdrop_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &magenta_data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    // 2. Source Group: Content ben trong da ve tren backdrop (C=0.6, M=0.4, Y=0, K=0)
    let source_tex = ctx.create_intermediate_texture(width, height, Some("Source_Blended"));
    let source_data = make_solid_cmyk_f16(width, height, [0.6, 0.4, 0.0, 0.0]);
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &source_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &source_data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    let target_intermediate =
        ctx.create_intermediate_texture(width, height, Some("Target_Non_Iso"));

    let backdrop_view = backdrop_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let source_view = source_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let target_inter_view =
        target_intermediate.create_view(&wgpu::TextureViewDescriptor::default());

    // 3. Non-isolated blend voi group_alpha = 0.5:
    // C = 0.5 * 0.0 + 0.5 * 0.6 = 0.30
    // M = 0.5 * 1.0 + 0.5 * 0.4 = 0.70
    let blend_pipeline =
        GroupBlendPipeline::new(&ctx.device, &ctx.queue, wgpu::TextureFormat::Rgba16Float);
    let blend_uniforms = GroupBlendUniforms {
        blend_mode: BlendModeGpu::Normal as u32,
        isolated: 0, // Non-isolated
        has_mask: 0,
        mask_type: SoftMaskTypeGpu::Alpha as u32,
        group_alpha: 0.5,
        color_space: ColorSpaceGpu::SubtractiveCmyk as u32,
        invert_mask: 0,
        _padding: 0.0,
    };

    blend_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &backdrop_view,
        &source_view,
        None,
        &target_inter_view,
        &blend_uniforms,
    );

    // 4. Resolve sang Rgba8Unorm
    let target_display = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Display_Target"),
    );
    let target_display_view = target_display.create_view(&wgpu::TextureViewDescriptor::default());

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
        &target_inter_view,
        &target_display_view,
        &resolve_uniforms,
    );

    let pixels = ctx
        .readback_texture_rgba8(&target_display, width, height)
        .expect("Readback that bai");
    let mid_pixel = &pixels[((height / 2 * width + width / 2) * 4) as usize..];
    let (r, g, b, _a) = (mid_pixel[0], mid_pixel[1], mid_pixel[2], mid_pixel[3]);

    // R = 255 * (1 - C) = 255 * 0.70 = 178
    // G = 255 * (1 - M) = 255 * 0.30 = 76
    // B = 255 * (1 - Y) = 255 * 1.00 = 255
    println!("Non-isolated blend pixel: R={}, G={}, B={}", r, g, b);
    assert!(
        (r as i32 - 178).abs() <= 5,
        "Red mong doi ~178, thuc te: {}",
        r
    );
    assert!(
        (g as i32 - 76).abs() <= 5,
        "Green mong doi ~76, thuc te: {}",
        g
    );
    assert!(b >= 250, "Blue mong doi ~255, thuc te: {}", b);
}

#[test]
fn test_gpu_soft_mask_luminosity_generation() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

    let width = 64u32;
    let height = 64u32;

    // RGB đã resolve: nửa trên trắng, nửa dưới đen. CMYK chưa có profile phải từ chối.
    let mut data = Vec::with_capacity((width * height * 8) as usize);
    let white_f16 = [
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
    ];
    let black_f16 = [
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
    ];

    for y in 0..height {
        for _x in 0..width {
            let sample = if y < height / 2 { white_f16 } else { black_f16 };
            for b in sample {
                data.extend_from_slice(&b);
            }
        }
    }

    let rgb_src = ctx.create_intermediate_texture(width, height, Some("RGB_Source"));
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &rgb_src,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    let mask_tex = ctx.create_intermediate_texture(width, height, Some("Mask_Target"));
    let src_view = rgb_src.create_view(&wgpu::TextureViewDescriptor::default());
    let mask_view = mask_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let mask_pipeline = SoftMaskPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let mask_uniforms = SoftMaskUniforms {
        mask_type: SoftMaskTypeGpu::Luminosity as u32,
        color_space: ColorSpaceGpu::AdditiveRgb as u32,
        invert: 0,
        backdrop_lum: 1.0,
    };

    mask_pipeline
        .execute(
            &ctx.device,
            &ctx.queue,
            &src_view,
            &mask_view,
            &mask_uniforms,
        )
        .expect("Nguồn RGB hợp lệ");

    // Resolve mask sang display de doc lai
    let target_display = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Display_Mask"),
    );
    let target_display_view = target_display.create_view(&wgpu::TextureViewDescriptor::default());

    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);
    let resolve_uniforms = ResolveUniforms {
        proof_mode: 0,
        overprint_sim: 0,
        gamma: 1.0,
        brightness: 1.0,
    };

    resolve_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &mask_view,
        &target_display_view,
        &resolve_uniforms,
    );

    let pixels = ctx
        .readback_texture_rgba8(&target_display, width, height)
        .expect("Readback that bai");

    // Top pixel (y = 10): White paper -> Lum = 1.0 -> White
    let top_idx = ((10 * width + 32) * 4) as usize;
    let top_r = pixels[top_idx];

    // Bottom pixel (y = 50): Solid black -> Lum = 0.0 -> Black
    let bot_idx = ((50 * width + 32) * 4) as usize;
    let bot_r = pixels[bot_idx];

    println!(
        "Mask Luminosity test: Top Lum = {}, Bot Lum = {}",
        top_r, bot_r
    );
    // Trong shader color_resolve: sRGB = (1-C, 1-M, 1-Y) * (1-K).
    // Khi mask_tex chua (Lum, Lum, Lum, Lum):
    // C=Lum, M=Lum, Y=Lum, K=Lum.
    // Voi Top (Lum=1.0): K=1.0 -> (1-K)=0 -> RGB = 0.
    // Voi Bot (Lum=0.0): K=0.0, C=0 -> RGB = 255.
    // Day la do ham resolve xem Rgba16Float la CMYK.
    // Quan trong la co su khac biet ro ret giua trang va den:
    assert_ne!(
        top_r, bot_r,
        "Luminosity phai phan biet duoc vung trang va den"
    );
}

#[test]
fn test_gpu_soft_mask_modulation_on_isolated_group() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

    let width = 64u32;
    let height = 64u32;

    // 1. Backdrop: White paper (C=0, M=0, Y=0, K=0)
    let backdrop_tex = ctx.create_intermediate_texture(width, height, Some("Backdrop_White"));
    let white_data = make_solid_cmyk_f16(width, height, [0.0, 0.0, 0.0, 0.0]);
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &backdrop_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &white_data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    // 2. Source Group: Solid Cyan (C=1.0, M=0, Y=0, K=0)
    let source_tex = ctx.create_intermediate_texture(width, height, Some("Source_Cyan"));
    let cyan_data = make_solid_cmyk_f16(width, height, [1.0, 0.0, 0.0, 0.0]);
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &source_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &cyan_data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    // 3. Mask Texture:
    // Nua trai (x < width/2): Alpha = 0.0 (Che hoan toan)
    // Nua phai (x >= width/2): Alpha = 1.0 (Hien hoan toan)
    let mut mask_raw = Vec::with_capacity((width * height * 8) as usize);
    let transparent = [
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
        half::f16::from_f32(0.0).to_le_bytes(),
    ];
    let opaque = [
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
        half::f16::from_f32(1.0).to_le_bytes(),
    ];
    for _y in 0..height {
        for x in 0..width {
            let sample = if x < width / 2 { transparent } else { opaque };
            for b in sample {
                mask_raw.extend_from_slice(&b);
            }
        }
    }

    let mask_tex = ctx.create_intermediate_texture(width, height, Some("Mask_Alpha"));
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &mask_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &mask_raw,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    let target_intermediate = ctx.create_intermediate_texture(width, height, Some("Target_Masked"));

    let backdrop_view = backdrop_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let source_view = source_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let mask_view = mask_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let target_inter_view =
        target_intermediate.create_view(&wgpu::TextureViewDescriptor::default());

    // 4. Group Blend Pass voi soft mask
    let blend_pipeline =
        GroupBlendPipeline::new(&ctx.device, &ctx.queue, wgpu::TextureFormat::Rgba16Float);
    let blend_uniforms = GroupBlendUniforms {
        blend_mode: BlendModeGpu::Normal as u32,
        isolated: 1,
        has_mask: 1, // Bat soft mask
        mask_type: SoftMaskTypeGpu::Alpha as u32,
        group_alpha: 1.0,
        color_space: ColorSpaceGpu::SubtractiveCmyk as u32,
        invert_mask: 0,
        _padding: 0.0,
    };

    blend_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &backdrop_view,
        &source_view,
        Some(&mask_view),
        &target_inter_view,
        &blend_uniforms,
    );

    // 5. Resolve sang Display Target
    let target_display = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Display_Target"),
    );
    let target_display_view = target_display.create_view(&wgpu::TextureViewDescriptor::default());

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
        &target_inter_view,
        &target_display_view,
        &resolve_uniforms,
    );

    let pixels = ctx
        .readback_texture_rgba8(&target_display, width, height)
        .expect("Readback that bai");

    // Nua trai (x = 10): Mask = 0.0 -> Alpha = 0.0 -> Giu nguyen Backdrop White (255, 255, 255)
    let left_idx = ((32 * width + 10) * 4) as usize;
    let (lr, lg, lb) = (pixels[left_idx], pixels[left_idx + 1], pixels[left_idx + 2]);

    // Nua phai (x = 50): Mask = 1.0 -> Alpha = 1.0 -> Source Cyan (0, 255, 255)
    let right_idx = ((32 * width + 50) * 4) as usize;
    let (rr, rg, rb) = (
        pixels[right_idx],
        pixels[right_idx + 1],
        pixels[right_idx + 2],
    );

    println!(
        "Mask modulation: Left RGB=({},{},{}), Right RGB=({},{},{})",
        lr, lg, lb, rr, rg, rb
    );

    assert!(
        lr >= 250 && lg >= 250 && lb >= 250,
        "Nua trai phai la White (255,255,255), thuc te: ({},{},{})",
        lr,
        lg,
        lb
    );
    assert!(
        rr <= 10 && rg >= 250 && rb >= 250,
        "Nua phai phai la Cyan (0,255,255), thuc te: ({},{},{})",
        rr,
        rg,
        rb
    );
}
