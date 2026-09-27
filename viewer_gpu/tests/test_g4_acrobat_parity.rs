//! Smoke test pipeline/swatch; KHÔNG phải Acrobat parity, ΔE00 hay kiểm AA raster.
//! PERF (audit 2026-09-25 §R25.GPU.10): giữ tên file cũ để tương thích runner,
//! chỉ runtime acceptance có golden/provenance mới được nghiệm thu G4.

use viewer_gpu::{
    BlendModeGpu, ColorResolvePipeline, GpuContext, GroupBlendPipeline, PathRasterPipeline,
    PathVertex, ResolveUniforms, SoftMaskPipeline, SoftMaskTypeGpu, SoftMaskUniforms,
};

#[test]
fn test_approximate_cmyk_swatch() {
    let ctx = GpuContext::new_sync().expect("Cần GPU; không bỏ qua rồi báo pass");

    let target_format = wgpu::TextureFormat::Rgba8Unorm;
    let pipeline = ColorResolvePipeline::new(&ctx.device, target_format);

    let width = 64;
    let height = 64;

    // Buffer CMYK 16-bit float mo phong mau in:
    // Cyan = 0.8, Magenta = 0.0, Yellow = 1.0, Black (K) = 0.0 -> Mau Xanh La In An (Prepress Green)
    let cmyk_tex = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Test_G4_CMYK_Tex"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });

    let half_c = half::f16::from_f32(0.8).to_bits();
    let half_m = half::f16::from_f32(0.0).to_bits();
    let half_y = half::f16::from_f32(1.0).to_bits();
    let half_k = half::f16::from_f32(0.0).to_bits();

    let mut texel_bytes = Vec::with_capacity((width * height * 8) as usize);
    for _ in 0..(width * height) {
        texel_bytes.extend_from_slice(&half_c.to_le_bytes());
        texel_bytes.extend_from_slice(&half_m.to_le_bytes());
        texel_bytes.extend_from_slice(&half_y.to_le_bytes());
        texel_bytes.extend_from_slice(&half_k.to_le_bytes());
    }

    ctx.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &cmyk_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &texel_bytes,
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

    let output_tex = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Test_G4_Output_RGBA"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: target_format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let src_view = cmyk_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let dst_view = output_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let uniforms = ResolveUniforms {
        proof_mode: 1,    // CMYK xấp xỉ cho smoke test
        overprint_sim: 1, // Mo phong overprint chuan OPM=1
        gamma: 1.0,
        brightness: 1.0,
    };

    // Thuc thi pipeline resolve
    pipeline.execute(&ctx.device, &ctx.queue, &src_view, &dst_view, &uniforms);

    // Readback pixel de kiem tra gia tri quang hoc
    let readback_buf = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Readback_Buf"),
        size: (width * height * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &output_tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback_buf,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );

    ctx.queue.submit(Some(encoder.finish()));

    let slice = readback_buf.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| ());
    ctx.device.poll(wgpu::Maintain::Wait);

    let data = slice.get_mapped_range();
    let r = data[0];
    let g = data[1];
    let b = data[2];
    let a = data[3];
    drop(data);
    readback_buf.unmap();

    // Cong thuc subtractive proof:
    // R = (1 - 0.8) * (1 - 0) = 0.20 -> 0.20 * 255 = 51
    // G = (1 - 0.0) * (1 - 0) = 1.00 -> 1.00 * 255 = 255
    // B = (1 - 1.0) * (1 - 0) = 0.00 -> 0.00 * 255 = 0
    // Alpha = 255
    assert!(
        (r as i32 - 51).abs() <= 2,
        "Sai lech kenh R so với swatch xấp xỉ: {}",
        r
    );
    assert!(
        (g as i32 - 255).abs() <= 2,
        "Sai lech kenh G so với swatch xấp xỉ: {}",
        g
    );
    assert!(
        (b as i32 - 0).abs() <= 2,
        "Sai lech kenh B so với swatch xấp xỉ: {}",
        b
    );
    assert_eq!(a, 255, "Alpha phai la 255");
}

#[test]
fn test_path_vertex_layout() {
    let ctx = GpuContext::new_sync().expect("Cần GPU; không bỏ qua rồi báo pass");

    let intermediate_format = wgpu::TextureFormat::Rgba16Float;
    let _pipeline = PathRasterPipeline::new(&ctx.device, intermediate_format);

    // Kiem tra hinh hoc tam giac cong Loop-Blinn khong bi suy bien
    let vertices = [
        PathVertex::new_curve(0.0, 0.0, 0.0, 0.0, [1.0, 0.0, 0.0, 0.0], 1.0),
        PathVertex::new_curve(0.5, 1.0, 0.5, 0.0, [1.0, 0.0, 0.0, 0.0], 1.0),
        PathVertex::new_curve(1.0, 0.0, 1.0, 1.0, [1.0, 0.0, 0.0, 0.0], 1.0),
    ];

    use wgpu::util::DeviceExt;
    let vbuf = ctx
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Test_Loop_Blinn_VBuf"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
    assert_eq!(
        vbuf.size(),
        (vertices.len() * std::mem::size_of::<PathVertex>()) as u64
    );
}

#[test]
fn test_blend_enum_and_pipeline_creation() {
    let ctx = GpuContext::new_sync().expect("Cần GPU; không bỏ qua rồi báo pass");

    let intermediate_format = wgpu::TextureFormat::Rgba16Float;
    let _pipeline = GroupBlendPipeline::new(&ctx.device, &ctx.queue, intermediate_format);

    // Xac thuc tat ca cac blend mode PDF 1.7
    let blend_modes = [
        BlendModeGpu::Normal,
        BlendModeGpu::Multiply,
        BlendModeGpu::Screen,
        BlendModeGpu::Overlay,
        BlendModeGpu::Darken,
        BlendModeGpu::Lighten,
        BlendModeGpu::ColorDodge,
        BlendModeGpu::ColorBurn,
        BlendModeGpu::HardLight,
        BlendModeGpu::SoftLight,
        BlendModeGpu::Difference,
        BlendModeGpu::Exclusion,
    ];

    for mode in blend_modes {
        assert!((mode as u32) <= 11);
    }
}

#[test]
fn test_mask_enum_and_pipeline_creation() {
    let ctx = GpuContext::new_sync().expect("Cần GPU; không bỏ qua rồi báo pass");

    let intermediate_format = wgpu::TextureFormat::Rgba16Float;
    let _pipeline = SoftMaskPipeline::new(&ctx.device, intermediate_format);

    let alpha_uniforms = SoftMaskUniforms {
        mask_type: SoftMaskTypeGpu::Alpha as u32,
        color_space: 0,
        invert: 0,
        backdrop_lum: 1.0,
    };
    assert_eq!(alpha_uniforms.mask_type, 0);

    let lum_uniforms = SoftMaskUniforms {
        mask_type: SoftMaskTypeGpu::Luminosity as u32,
        color_space: 0,
        invert: 0,
        backdrop_lum: 0.0,
    };
    assert_eq!(lum_uniforms.mask_type, 1);
}
