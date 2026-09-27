//! PPE Viewer GPU - Image Sampling & Affine Mapping Pipeline (Milestone G2.4)
//!
//! Quan ly RenderPipeline thuc thi ve anh raster (CMYK, RGB, Image Mask)
//! len Intermediate Surface voi ma tran bien doi hinh hoc affine CTM.

use bytemuck::{Pod, Zeroable};

/// Dinh cua quad ve anh
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct ImageVertex {
    pub position: [f32; 2],
    pub uv: [f32; 2],
}

impl ImageVertex {
    pub fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<ImageVertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                // Position: [f32; 2]
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                // UV: [f32; 2]
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x2,
                },
            ],
        }
    }
}

/// Tao 6 dinh cho unit quad (0.0 .. 1.0) chia lam 2 tam giac
pub fn create_unit_quad_vertices() -> [ImageVertex; 6] {
    [
        // Triangle 1
        ImageVertex {
            position: [0.0, 0.0],
            uv: [0.0, 0.0],
        },
        ImageVertex {
            position: [1.0, 0.0],
            uv: [1.0, 0.0],
        },
        ImageVertex {
            position: [0.0, 1.0],
            uv: [0.0, 1.0],
        },
        // Triangle 2
        ImageVertex {
            position: [1.0, 0.0],
            uv: [1.0, 0.0],
        },
        ImageVertex {
            position: [1.0, 1.0],
            uv: [1.0, 1.0],
        },
        ImageVertex {
            position: [0.0, 1.0],
            uv: [0.0, 1.0],
        },
    ]
}

/// Tham so Uniform cho Image Pipeline (dung 96 bytes std140)
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct ImageUniforms {
    pub transform_matrix: [f32; 16], // offset 0..64
    pub tint_cmyk: [f32; 4],         // offset 64..80
    pub color_type: u32,             // offset 80..84: 0 = CMYK, 1 = RGB, 2 = Image Mask
    pub has_alpha: u32,              // offset 84..88
    pub alpha: f32,                  // offset 88..92
    pub _padding: f32,               // offset 92..96
}

impl Default for ImageUniforms {
    fn default() -> Self {
        // Identity matrix
        let mut mat = [0.0f32; 16];
        mat[0] = 1.0;
        mat[5] = 1.0;
        mat[10] = 1.0;
        mat[15] = 1.0;

        Self {
            transform_matrix: mat,
            tint_cmyk: [0.0, 0.0, 0.0, 1.0], // Mac dinh Black
            color_type: 0,                   // CMYK
            has_alpha: 0,
            alpha: 1.0,
            _padding: 0.0,
        }
    }
}

/// Pipeline ve anh va image mask len GPU surface
pub struct ImageSamplePipeline {
    pub pipeline: wgpu::RenderPipeline,
    coverage_pipeline: wgpu::RenderPipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub linear_sampler: wgpu::Sampler,
    pub nearest_sampler: wgpu::Sampler,
    pub uniform_buffer: wgpu::Buffer,
    pub vertex_buffer: wgpu::Buffer,
}

impl ImageSamplePipeline {
    pub fn new(device: &wgpu::Device, target_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Image_Sample_Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/image_sample.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Image_Sample_Bind_Group_Layout"),
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
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
            label: Some("Image_Sample_Pipeline_Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let make_pipeline = |entry_point, blend| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Image_Sample_Render_Pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[ImageVertex::desc()],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry_point),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target_format,
                        blend: Some(blend),
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
            })
        };

        // PERF (audit 2026-09-25 §R25.GPU.04/06): giảm nền bằng alpha riêng,
        // sau đó cộng CMYK premultiplied. Không lấy K làm opacity.
        let blend = |src_factor, dst_factor| {
            let component = wgpu::BlendComponent {
                src_factor,
                dst_factor,
                operation: wgpu::BlendOperation::Add,
            };
            wgpu::BlendState {
                color: component,
                alpha: component,
            }
        };
        let coverage_pipeline = make_pipeline(
            "fs_coverage",
            blend(wgpu::BlendFactor::Zero, wgpu::BlendFactor::OneMinusSrcAlpha),
        );
        let pipeline = make_pipeline(
            "fs_main",
            blend(wgpu::BlendFactor::One, wgpu::BlendFactor::One),
        );
        let linear_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Image_Linear_Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let nearest_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Image_Nearest_Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Image_Uniform_Buffer"),
            size: std::mem::size_of::<ImageUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Tao vertex buffer san cho unit quad 6 dinh
        let quad_vertices = create_unit_quad_vertices();
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Image_Quad_Vertex_Buffer"),
            size: std::mem::size_of_val(&quad_vertices) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            coverage_pipeline,
            bind_group_layout,
            linear_sampler,
            nearest_sampler,
            uniform_buffer,
            vertex_buffer,
        }
    }

    /// Thuc thi pass ve anh len target_view
    pub fn execute(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        image_view: &wgpu::TextureView,
        target_view: &wgpu::TextureView,
        uniforms: &ImageUniforms,
        interpolate: bool,
    ) {
        self.composite(
            device,
            queue,
            image_view,
            target_view,
            uniforms,
            interpolate,
            true,
        );
    }

    /// Composite ảnh lên mực nền; alpha pixel chỉ có ở đầu vào RGB, không ở K.
    pub fn composite(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        image_view: &wgpu::TextureView,
        target_view: &wgpu::TextureView,
        uniforms: &ImageUniforms,
        interpolate: bool,
        clear: bool,
    ) {
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(uniforms));

        let quad = create_unit_quad_vertices();
        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&quad));

        let sampler = if interpolate {
            &self.linear_sampler
        } else {
            &self.nearest_sampler
        };

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Image_Sample_Bind_Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(image_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Image_Sample_Encoder"),
        });

        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Image_Sample_Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: if clear {
                            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            rpass.set_pipeline(&self.coverage_pipeline);
            rpass.set_bind_group(0, &bind_group, &[]);
            rpass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
            rpass.draw(0..6, 0..1);
            rpass.set_pipeline(&self.pipeline);
            rpass.draw(0..6, 0..1);
        }

        queue.submit(Some(encoder.finish()));
    }
}
