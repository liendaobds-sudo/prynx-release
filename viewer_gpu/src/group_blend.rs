//! PPE Viewer GPU - Transparency Group Compositing & Soft Mask Pipelines (Milestone G2.3)
//!
//! Thuc thi hoa tron Transparency Group (isolated va non-isolated) tren GPU
//! theo tieu chuan ISO 32000-2 §11, ho tro 12 blend modes va soft mask (Alpha/Luminosity).

use bytemuck::{Pod, Zeroable};

/// Cac che do hoa tron Blend Mode ho tro tren GPU.
#[repr(u32)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum BlendModeGpu {
    #[default]
    Normal = 0,
    Multiply = 1,
    Screen = 2,
    Overlay = 3,
    Darken = 4,
    Lighten = 5,
    ColorDodge = 6,
    ColorBurn = 7,
    HardLight = 8,
    SoftLight = 9,
    Difference = 10,
    Exclusion = 11,
}

impl BlendModeGpu {
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "Normal" => Self::Normal,
            "Multiply" => Self::Multiply,
            "Screen" => Self::Screen,
            "Overlay" => Self::Overlay,
            "Darken" => Self::Darken,
            "Lighten" => Self::Lighten,
            "ColorDodge" => Self::ColorDodge,
            "ColorBurn" => Self::ColorBurn,
            "HardLight" => Self::HardLight,
            "SoftLight" => Self::SoftLight,
            "Difference" => Self::Difference,
            "Exclusion" => Self::Exclusion,
            _ => return None,
        })
    }
}

/// Loai Soft Mask.
#[repr(u32)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum SoftMaskTypeGpu {
    #[default]
    Alpha = 0,
    Luminosity = 1,
}

/// Khong gian mau cho phep hoa tron.
#[repr(u32)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum ColorSpaceGpu {
    #[default]
    SubtractiveCmyk = 0,
    AdditiveRgb = 1,
}

/// Tham so Uniform cho Group Blend Pass.
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct GroupBlendUniforms {
    pub blend_mode: u32,
    pub isolated: u32,
    pub has_mask: u32,
    pub mask_type: u32,
    pub group_alpha: f32,
    pub color_space: u32,
    pub invert_mask: u32,
    pub _padding: f32,
}

impl Default for GroupBlendUniforms {
    fn default() -> Self {
        Self {
            blend_mode: BlendModeGpu::Normal as u32,
            isolated: 1, // Mac dinh la isolated group
            has_mask: 0,
            mask_type: SoftMaskTypeGpu::Alpha as u32,
            group_alpha: 1.0,
            color_space: ColorSpaceGpu::SubtractiveCmyk as u32,
            invert_mask: 0,
            _padding: 0.0,
        }
    }
}

/// Tham so Uniform cho Soft Mask Generation Pass.
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct SoftMaskUniforms {
    pub mask_type: u32,
    pub color_space: u32,
    pub invert: u32,
    pub backdrop_lum: f32,
}

impl Default for SoftMaskUniforms {
    fn default() -> Self {
        Self {
            mask_type: SoftMaskTypeGpu::Luminosity as u32,
            color_space: ColorSpaceGpu::SubtractiveCmyk as u32,
            invert: 0,
            backdrop_lum: 1.0,
        }
    }
}

/// Pipeline hoa tron Transparency Group tren GPU.
pub struct GroupBlendPipeline {
    pub pipeline: wgpu::RenderPipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
    pub uniform_buffer: wgpu::Buffer,
    pub dummy_mask_texture: wgpu::Texture,
    pub dummy_mask_view: wgpu::TextureView,
}

impl GroupBlendPipeline {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target_format: wgpu::TextureFormat,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Group_Blend_Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/group_blend.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Group_Blend_Bind_Group_Layout"),
            entries: &[
                // Binding 0: Backdrop Texture
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
                // Binding 1: Source Group Texture
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Binding 2: Mask Texture
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Binding 3: Sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Binding 4: Uniforms
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
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
            label: Some("Group_Blend_Pipeline_Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Group_Blend_Render_Pipeline"),
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
                compilation_options: Default::default(),
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
            label: Some("Group_Blend_Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Group_Blend_Uniform_Buffer"),
            size: std::mem::size_of::<GroupBlendUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Tao dummy mask texture 1x1 trang (1.0, 1.0, 1.0, 1.0) dung khi group khong co soft mask
        let dummy_mask_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Dummy_Mask_Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let white_f16 = [
            half::f16::from_f32(1.0).to_le_bytes(),
            half::f16::from_f32(1.0).to_le_bytes(),
            half::f16::from_f32(1.0).to_le_bytes(),
            half::f16::from_f32(1.0).to_le_bytes(),
        ];
        let mut raw_bytes = Vec::with_capacity(8);
        for b in white_f16 {
            raw_bytes.extend_from_slice(&b);
        }

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &dummy_mask_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &raw_bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(8),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );

        let dummy_mask_view =
            dummy_mask_texture.create_view(&wgpu::TextureViewDescriptor::default());

        Self {
            pipeline,
            bind_group_layout,
            sampler,
            uniform_buffer,
            dummy_mask_texture,
            dummy_mask_view,
        }
    }

    /// Thuc thi pass hoa tron nhom len target_view.
    pub fn execute(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        backdrop_view: &wgpu::TextureView,
        source_view: &wgpu::TextureView,
        mask_view: Option<&wgpu::TextureView>,
        target_view: &wgpu::TextureView,
        uniforms: &GroupBlendUniforms,
    ) {
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(uniforms));

        let active_mask_view = mask_view.unwrap_or(&self.dummy_mask_view);

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Group_Blend_Bind_Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(backdrop_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(source_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(active_mask_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: self.uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Group_Blend_Encoder"),
        });

        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Group_Blend_Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
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

/// Pipeline tao Soft Mask (Luminosity hoac Alpha) tu mot texture dau vao.
pub struct SoftMaskPipeline {
    pub pipeline: wgpu::RenderPipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
    pub uniform_buffer: wgpu::Buffer,
}

impl SoftMaskPipeline {
    pub fn new(device: &wgpu::Device, target_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Soft_Mask_Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/soft_mask.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Soft_Mask_Bind_Group_Layout"),
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
            label: Some("Soft_Mask_Pipeline_Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Soft_Mask_Render_Pipeline"),
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
                compilation_options: Default::default(),
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
            label: Some("Soft_Mask_Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Soft_Mask_Uniform_Buffer"),
            size: std::mem::size_of::<SoftMaskUniforms>() as u64,
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

    /// Nguồn luminosity là RGB đã resolve, nguồn alpha là RGBA hoặc scalar R (color_space=2).
    /// Mask output luôn là scalar coverage, không chứa CMYK. Caller phải xử lý UnsupportedPass.
    pub fn execute(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source_view: &wgpu::TextureView,
        target_view: &wgpu::TextureView,
        uniforms: &SoftMaskUniforms,
    ) -> Result<(), crate::device::GpuError> {
        // PERF (audit 2026-09-25 §R25.GPU.04/07): CMYK không mang alpha ở K.
        // CMYK luminosity cần color contract/profile, không dùng công thức RGB xấp xỉ.
        if uniforms.color_space == 0
            || uniforms.mask_type > 1
            || uniforms.color_space > 2
            || (uniforms.mask_type == 1 && uniforms.color_space == 2)
        {
            return Err(crate::device::GpuError::UnsupportedPass(
                "Mask cần alpha plane riêng hoặc nguồn RGB đã resolve màu bằng PPE".into(),
            ));
        }
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(uniforms));

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Soft_Mask_Bind_Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(source_view),
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
            label: Some("Soft_Mask_Encoder"),
        });

        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Soft_Mask_Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
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
        Ok(())
    }
}
