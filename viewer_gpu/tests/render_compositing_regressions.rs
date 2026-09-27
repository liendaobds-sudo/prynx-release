// PERF (audit 2026-09-25 §R25.GPU.04–06): đối chứng pixel GPU, không bỏ qua khi thiếu adapter.
use viewer_gpu::*;
fn uniform_texture(ctx: &GpuContext, value: [f32; 4]) -> wgpu::Texture {
    let tex = ctx.create_intermediate_texture(64, 64, Some("review_input"));
    let mut data = Vec::new();
    for _ in 0..64 * 64 {
        for c in value {
            data.extend_from_slice(&half::f16::from_f32(c).to_le_bytes());
        }
    }
    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(64 * 8),
            rows_per_image: Some(64),
        },
        wgpu::Extent3d {
            width: 64,
            height: 64,
            depth_or_array_layers: 1,
        },
    );
    tex
}

fn resolved_pixel(ctx: &GpuContext, input: &wgpu::Texture) -> [u8; 4] {
    let dst = ctx.create_target_texture(
        64,
        64,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("review_output"),
    );
    ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm).execute(
        &ctx.device,
        &ctx.queue,
        &input.create_view(&Default::default()),
        &dst.create_view(&Default::default()),
        &ResolveUniforms {
            proof_mode: 1,
            overprint_sim: 0,
            gamma: 1.,
            brightness: 1.,
        },
    );
    ctx.readback_texture_rgba8(&dst, 64, 64).unwrap()[0..4]
        .try_into()
        .unwrap()
}

#[test]
fn generated_luminosity_mask_is_used_once() {
    let ctx = GpuContext::new_sync().expect("GPU bắt buộc; không bỏ qua rồi báo pass");
    println!("adapter={}", ctx.adapter_info.name);
    let gray = uniform_texture(&ctx, [0.5, 0.5, 0.5, 1.]);
    let mask = ctx.create_intermediate_texture(64, 64, Some("review_mask"));
    SoftMaskPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float)
        .execute(
            &ctx.device,
            &ctx.queue,
            &gray.create_view(&Default::default()),
            &mask.create_view(&Default::default()),
            &SoftMaskUniforms {
                mask_type: 1,
                color_space: 1,
                invert: 0,
                backdrop_lum: 0.,
            },
        )
        .unwrap();
    let white = uniform_texture(&ctx, [0., 0., 0., 0.]);
    let cyan = uniform_texture(&ctx, [1., 0., 0., 0.]);
    let mixed = ctx.create_intermediate_texture(64, 64, Some("review_blend"));
    GroupBlendPipeline::new(&ctx.device, &ctx.queue, wgpu::TextureFormat::Rgba16Float).execute(
        &ctx.device,
        &ctx.queue,
        &white.create_view(&Default::default()),
        &cyan.create_view(&Default::default()),
        Some(&mask.create_view(&Default::default())),
        &mixed.create_view(&Default::default()),
        &GroupBlendUniforms {
            blend_mode: 0,
            isolated: 1,
            has_mask: 1,
            mask_type: 1,
            group_alpha: 1.,
            color_space: 0,
            invert_mask: 0,
            _padding: 0.,
        },
    );
    let px = resolved_pixel(&ctx, &mixed);
    println!("half_luminosity_cyan_over_white={px:?}; expected=[128,255,255,255]");
    assert!(
        (px[0] as i32 - 128).abs() <= 2,
        "Mask 0,5 phải tạo Cyan 50%, không phải 25%"
    );
}

#[test]
fn opaque_cyan_replaces_magenta_without_overprint() {
    let ctx = GpuContext::new_sync().expect("GPU bắt buộc; không bỏ qua rồi báo pass");
    let executor = HybridGraphExecutor::new(&ctx, wgpu::TextureFormat::Rgba8Unorm);
    let target = ctx.create_intermediate_texture(64, 64, Some("review_opaque"));
    let view = target.create_view(&Default::default());
    executor.execute_vector_rect(
        &ctx,
        &view,
        64,
        64,
        [0., 0., 64., 64.],
        [0., 1., 0., 0.],
        true,
    );
    executor.execute_vector_rect(
        &ctx,
        &view,
        64,
        64,
        [0., 0., 64., 64.],
        [1., 0., 0., 0.],
        false,
    );
    let px = resolved_pixel(&ctx, &target);
    println!("opaque_cyan_over_magenta={px:?}; expected=[0,255,255,255]");
    assert_eq!(
        px,
        [0, 255, 255, 255],
        "Normal/alpha=1 phải thay màu nền, không cộng mực như overprint"
    );
}

#[test]
fn transparent_rgb_image_keeps_white_background() {
    let ctx = GpuContext::new_sync().expect("GPU bắt buộc; không bỏ qua rồi báo pass");
    let red_transparent = uniform_texture(&ctx, [1., 0., 0., 0.]);
    let target = ctx.create_intermediate_texture(64, 64, Some("review_image"));
    ImageSamplePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float).execute(
        &ctx.device,
        &ctx.queue,
        &red_transparent.create_view(&Default::default()),
        &target.create_view(&Default::default()),
        &ImageUniforms {
            transform_matrix: [
                2., 0., 0., 0., 0., -2., 0., 0., 0., 0., 1., 0., -1., 1., 0., 1.,
            ],
            tint_cmyk: [0.; 4],
            color_type: 1,
            has_alpha: 1,
            alpha: 1.,
            _padding: 0.,
        },
        true,
    );
    let px = resolved_pixel(&ctx, &target);
    println!("transparent_red_on_white={px:?}; expected=[255,255,255,255]");
    assert_eq!(
        px,
        [255, 255, 255, 255],
        "Ảnh có alpha=0 không được hiện thành đỏ đặc"
    );
}

#[test]
fn opacity_is_independent_of_black_ink() {
    let ctx = GpuContext::new_sync().expect("Cần GPU để kiểm compositing");
    let raster = PathRasterPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    for black in [0.0, 0.5, 1.0] {
        for alpha in [0.0, 0.5, 1.0] {
            let target = uniform_texture(&ctx, [0.0, 1.0, 0.0, 0.0]);
            let mut vertices = vec![];
            let mut indices = vec![];
            push_rect_vertices(
                &mut vertices,
                &mut indices,
                0.0,
                0.0,
                64.0,
                64.0,
                [1.0, 0.0, 0.0, black],
                alpha,
            );
            raster.render(
                &ctx.device,
                &ctx.queue,
                &target.create_view(&Default::default()),
                &vertices,
                &indices,
                &PathUniforms {
                    viewport_width: 64.0,
                    viewport_height: 64.0,
                    device_scale: 1.0,
                    _pad: 0.0,
                },
                false,
            );
            let expected = [
                ((1.0 - alpha) * (1.0 - black * alpha) * 255.0) as u8,
                (alpha * (1.0 - black * alpha) * 255.0) as u8,
                ((1.0 - black * alpha) * 255.0) as u8,
                255,
            ];
            let actual = resolved_pixel(&ctx, &target);
            for i in 0..4 {
                assert!(
                    (actual[i] as i16 - expected[i] as i16).abs() <= 2,
                    "K={black}, alpha={alpha}: {actual:?} != {expected:?}"
                );
            }
        }
    }
}

#[test]
fn rgb_image_alpha_preserves_colored_backdrop() {
    let ctx = GpuContext::new_sync().expect("Cần GPU");
    let pipeline = ImageSamplePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    for alpha in [0.0, 0.5, 1.0] {
        let red = uniform_texture(&ctx, [1.0, 0.0, 0.0, alpha]);
        let target = uniform_texture(&ctx, [1.0, 0.0, 0.0, 0.0]);
        pipeline.composite(
            &ctx.device,
            &ctx.queue,
            &red.create_view(&Default::default()),
            &target.create_view(&Default::default()),
            &ImageUniforms {
                transform_matrix: [
                    2., 0., 0., 0., 0., -2., 0., 0., 0., 0., 1., 0., -1., 1., 0., 1.,
                ],
                tint_cmyk: [0.; 4],
                color_type: 1,
                has_alpha: 1,
                alpha: 1.,
                _padding: 0.,
            },
            true,
            false,
        );
        let actual = resolved_pixel(&ctx, &target);
        let expected = [
            (255.0 * alpha) as u8,
            (255.0 * (1.0 - alpha)) as u8,
            (255.0 * (1.0 - alpha)) as u8,
            255,
        ];
        for i in 0..4 {
            assert!(
                (actual[i] as i16 - expected[i] as i16).abs() <= 2,
                "alpha={alpha}: {actual:?} != {expected:?}"
            );
        }
    }
}

#[test]
fn alpha_mask_rejects_cmyk_and_accepts_separate_coverage_plane() {
    let ctx = GpuContext::new_sync().expect("Cần GPU");
    let pipeline = SoftMaskPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let source = uniform_texture(&ctx, [0.5, 0.0, 0.0, 0.0]);
    let mask = ctx.create_intermediate_texture(64, 64, None);
    let source_view = source.create_view(&Default::default());
    let view = mask.create_view(&Default::default());
    let mut params = SoftMaskUniforms {
        mask_type: 0,
        color_space: 0,
        invert: 0,
        backdrop_lum: 0.,
    };
    assert!(pipeline
        .execute(&ctx.device, &ctx.queue, &source_view, &view, &params)
        .is_err());
    params.color_space = 2;
    pipeline
        .execute(&ctx.device, &ctx.queue, &source_view, &view, &params)
        .unwrap();
    let display = ctx.create_target_texture(64, 64, wgpu::TextureFormat::Rgba8Unorm, None);
    ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm).execute(
        &ctx.device,
        &ctx.queue,
        &view,
        &display.create_view(&Default::default()),
        &ResolveUniforms {
            proof_mode: 0,
            overprint_sim: 0,
            gamma: 1.,
            brightness: 1.,
        },
    );
    let pixels = ctx.readback_texture_rgba8(&display, 64, 64).unwrap();
    assert!((pixels[0] as i16 - 128).abs() <= 2);
    assert_eq!(
        BlendModeGpu::from_name("Multiply"),
        Some(BlendModeGpu::Multiply)
    );
    assert_eq!(
        BlendModeGpu::from_name("Hue"),
        None,
        "Blend chưa hỗ trợ không được trở thành Normal"
    );
}

#[test]
fn srgb_surface_does_not_encode_display_rgb_twice() {
    let ctx = GpuContext::new_sync().expect("Cần GPU");
    let rgb = uniform_texture(&ctx, [0.25, 0.5, 0.75, 1.]);
    for format in [
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureFormat::Rgba8UnormSrgb,
    ] {
        let output = ctx.create_target_texture(64, 64, format, None);
        ColorResolvePipeline::new(&ctx.device, format).execute(
            &ctx.device,
            &ctx.queue,
            &rgb.create_view(&Default::default()),
            &output.create_view(&Default::default()),
            &ResolveUniforms {
                proof_mode: 0,
                overprint_sim: 0,
                gamma: 1.,
                brightness: 1.,
            },
        );
        let pixels = ctx.readback_texture_rgba8(&output, 64, 64).unwrap();
        for (i, expected) in [64i16, 128, 191, 255].iter().enumerate() {
            assert!(
                (pixels[i] as i16 - expected).abs() <= 2,
                "{format:?}: {:?}",
                &pixels[..4]
            );
        }
    }
}
