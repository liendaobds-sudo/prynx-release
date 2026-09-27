//! PPE Viewer GPU - Color Resolve Pipeline (Milestone G2.1)
//!
//! Quan ly RenderPipeline thuc thi Color Resolve pass tren GPU bang WGSL shader.
//! Chuyen doi tu intermediate Rgba16Float (CMYK) sang Target Surface (sRGB/Bgra8).

use bytemuck::{Pod, Zeroable};

/// Tham số pass hiển thị. `proof_mode=1` là swatch CMYK xấp xỉ để chẩn đoán,
/// KHÔNG phải ICC proof. Proof thật phải dùng RGB đã được PPE/ColorManager resolve.
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct ResolveUniforms {
    pub proof_mode: u32,
    pub overprint_sim: u32,
    pub gamma: f32,
    pub brightness: f32,
}

impl Default for ResolveUniforms {
    fn default() -> Self {
        Self {
            proof_mode: 1, // Bat che do proof CMYK
            overprint_sim: 1,
            gamma: 2.2,
            brightness: 1.0,
        }
    }
}

/// Pipeline thuc thi Color Resolve pass.
pub struct ColorResolvePipeline {
    pub pipeline: wgpu::RenderPipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
    pub uniform_buffer: wgpu::Buffer,
}

impl ColorResolvePipeline {
    pub fn new(device: &wgpu::Device, target_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Color_Resolve_Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/color_resolve.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Color_Resolve_Bind_Group_Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Color_Resolve_Pipeline_Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let constants = std::collections::HashMap::from([(
            "TARGET_SRGB".to_string(),
            if target_format.is_srgb() { 1.0 } else { 0.0 },
        )]);
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Color_Resolve_Render_Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: target_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &constants,
                    ..Default::default()
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Color_Resolve_Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Color_Resolve_Uniform_Buffer"),
            size: std::mem::size_of::<ResolveUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            bind_group_layout,
            sampler,
            uniform_buffer,
        }
    }

    /// Thuc thi pass resolve tu input_view sang target_view.
    pub fn execute(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        input_view: &wgpu::TextureView,
        target_view: &wgpu::TextureView,
        uniforms: &ResolveUniforms,
    ) {
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(uniforms));

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Color_Resolve_Bind_Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(input_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Color_Resolve_Encoder"),
        });

        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Color_Resolve_Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            rpass.set_pipeline(&self.pipeline);
            rpass.set_bind_group(0, &bind_group, &[]);
            rpass.draw(0..3, 0..1); // Fullscreen triangle
        }

        queue.submit(Some(encoder.finish()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::GpuContext;

    #[test]
    fn test_color_resolve_cmyk_to_srgb_quadrants() {
        let ctx = GpuContext::new_sync().expect("Khoi tao GPU Context that bai");

        let width = 64u32;
        let height = 64u32;

        // Tao intermediate texture Rgba16Float
        let intermediate =
            ctx.create_intermediate_texture(width, height, Some("Test_Intermediate"));

        // Chuan bi du lieu 4 goc:
        // Top-Left (Cyan): [1.0, 0.0, 0.0, 0.0] -> RGB: [0, 255, 255]
        // Top-Right (Magenta): [0.0, 1.0, 0.0, 0.0] -> RGB: [255, 0, 255]
        // Bottom-Left (Yellow): [0.0, 0.0, 1.0, 0.0] -> RGB: [255, 255, 0]
        // Bottom-Right (Black): [0.0, 0.0, 0.0, 1.0] -> RGB: [0, 0, 0]
        let mut f16_data = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let is_right = x >= width / 2;
                let is_bottom = y >= height / 2;

                let cmyk: [f32; 4] = match (is_right, is_bottom) {
                    (false, false) => [1.0, 0.0, 0.0, 0.0], // Cyan
                    (true, false) => [0.0, 1.0, 0.0, 0.0],  // Magenta
                    (false, true) => [0.0, 0.0, 1.0, 0.0],  // Yellow
                    (true, true) => [0.0, 0.0, 0.0, 1.0],   // Black
                };

                for val in cmyk {
                    let half = half::f16::from_f32(val);
                    f16_data.extend_from_slice(&half.to_le_bytes());
                }
            }
        }

        ctx.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &intermediate,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &f16_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 8), // 4 channels * 2 bytes (f16) = 8 bytes/pixel
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        // Tao target texture Rgba8Unorm
        let target = ctx.create_target_texture(
            width,
            height,
            wgpu::TextureFormat::Rgba8Unorm,
            Some("Test_Target"),
        );

        let pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);
        let input_view = intermediate.create_view(&wgpu::TextureViewDescriptor::default());
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

        pipeline.execute(
            &ctx.device,
            &ctx.queue,
            &input_view,
            &target_view,
            &ResolveUniforms::default(),
        );

        // Doc lai ket qua va kiem tra mau
        let pixels = ctx
            .readback_texture_rgba8(&target, width, height)
            .expect("Doc lai pixel that bai");

        let sample_pixel = |x: u32, y: u32| -> (u8, u8, u8) {
            let idx = ((y * width + x) * 4) as usize;
            (pixels[idx], pixels[idx + 1], pixels[idx + 2])
        };

        // 1. Top-Left: Cyan (R=0, G=255, B=255)
        let (cr, cg, cb) = sample_pixel(16, 16);
        assert!(cr <= 5, "Cyan R phai bang 0 (thuc te: {cr})");
        assert!(cg >= 250, "Cyan G phai bang 255 (thuc te: {cg})");
        assert!(cb >= 250, "Cyan B phai bang 255 (thuc te: {cb})");

        // 2. Top-Right: Magenta (R=255, G=0, B=255)
        let (mr, mg, mb) = sample_pixel(48, 16);
        assert!(mr >= 250, "Magenta R phai bang 255 (thuc te: {mr})");
        assert!(mg <= 5, "Magenta G phai bang 0 (thuc te: {mg})");
        assert!(mb >= 250, "Magenta B phai bang 255 (thuc te: {mb})");

        // 3. Bottom-Left: Yellow (R=255, G=255, B=0)
        let (yr, yg, yb) = sample_pixel(16, 48);
        assert!(yr >= 250, "Yellow R phai bang 255 (thuc te: {yr})");
        assert!(yg >= 250, "Yellow G phai bang 255 (thuc te: {yg})");
        assert!(yb <= 5, "Yellow B phai bang 0 (thuc te: {yb})");

        // 4. Bottom-Right: Black (R=0, G=0, B=0)
        let (kr, kg, kb) = sample_pixel(48, 48);
        assert!(kr <= 5, "Black R phai bang 0 (thuc te: {kr})");
        assert!(kg <= 5, "Black G phai bang 0 (thuc te: {kg})");
        assert!(kb <= 5, "Black B phai bang 0 (thuc te: {kb})");
    }
}
