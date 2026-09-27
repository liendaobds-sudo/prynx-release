//! PPE Viewer GPU - Vector Path Rasterizer Pipeline (Milestone G2.2)
//!
//! Pipeline rasterize cac doi tuong vector (hinh chu nhat, da giac, duong cong Bezier)
//! truc tiep len intermediate texture Rgba16Float voi Anti-Aliasing (AA) analytical.

use bytemuck::{Pod, Zeroable};

/// Uniform parameters truyen cho vertex shader cua path rasterizer.
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct PathUniforms {
    pub viewport_width: f32,
    pub viewport_height: f32,
    pub device_scale: f32,
    pub _pad: f32,
}

/// Dinh vector truyen vao GPU path pipeline.
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct PathVertex {
    pub position: [f32; 2],
    pub uv: [f32; 2],
    pub color: [f32; 4], // [c, m, y, k]
    pub flags: u32,      // bit 0: is_curve (Loop-Blinn)
    pub alpha: f32,
}

impl PathVertex {
    pub fn new_flat(x: f32, y: f32, color: [f32; 4], alpha: f32) -> Self {
        Self {
            position: [x, y],
            uv: [0.0, 0.0],
            color,
            flags: 0,
            alpha,
        }
    }

    pub fn new_curve(x: f32, y: f32, u: f32, v: f32, color: [f32; 4], alpha: f32) -> Self {
        Self {
            position: [x, y],
            uv: [u, v],
            color,
            flags: 1, // is_curve = true
            alpha,
        }
    }
}

/// Pipeline dieu phoi rasterization vector tren GPU.
pub struct PathRasterPipeline {
    pub pipeline: wgpu::RenderPipeline,
    coverage_pipeline: wgpu::RenderPipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub uniform_buffer: wgpu::Buffer,
}

impl PathRasterPipeline {
    pub fn new(device: &wgpu::Device, intermediate_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Path_Raster_Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/path_raster.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Path_Raster_Bind_Group_Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Path_Raster_Pipeline_Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let vertex_buffer_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<PathVertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                // location 0: position
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 0,
                    shader_location: 0,
                },
                // location 1: uv
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 8,
                    shader_location: 1,
                },
                // location 2: color
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x4,
                    offset: 16,
                    shader_location: 2,
                },
                // location 3: flags
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Uint32,
                    offset: 32,
                    shader_location: 3,
                },
                // location 4: alpha
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32,
                    offset: 36,
                    shader_location: 4,
                },
            ],
        };

        let make_pipeline = |entry_point, blend| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Path_Raster_Render_Pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_path"),
                    buffers: &[vertex_buffer_layout.clone()],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry_point),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: intermediate_format,
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

        // PERF (audit 2026-09-25 §R25.GPU.04): CMYK chứa K ở thành phần thứ tư.
        // Hai draw cho mỗi primitive: giảm nền bằng coverage riêng rồi cộng mực.
        // K không bao giờ được dùng làm alpha trong blend của pass màu.
        let component = |src_factor, dst_factor| wgpu::BlendComponent {
            src_factor,
            dst_factor,
            operation: wgpu::BlendOperation::Add,
        };
        let coverage = component(wgpu::BlendFactor::Zero, wgpu::BlendFactor::OneMinusSrcAlpha);
        let additive = component(wgpu::BlendFactor::One, wgpu::BlendFactor::One);
        let coverage_pipeline = make_pipeline(
            "fs_coverage",
            wgpu::BlendState {
                color: coverage,
                alpha: coverage,
            },
        );
        let pipeline = make_pipeline(
            "fs_path",
            wgpu::BlendState {
                color: additive,
                alpha: additive,
            },
        );

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Path_Raster_Uniform_Buffer"),
            size: std::mem::size_of::<PathUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            coverage_pipeline,
            bind_group_layout,
            uniform_buffer,
        }
    }

    /// Thuc thi ve danh sach cac dinh vector len target texture view (intermediate Rgba16Float).
    pub fn render(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target_view: &wgpu::TextureView,
        vertices: &[PathVertex],
        indices: &[u16],
        uniforms: &PathUniforms,
        clear: bool,
    ) {
        if vertices.is_empty() || indices.is_empty() {
            return;
        }

        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(uniforms));

        use wgpu::util::DeviceExt;
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Path_Vertex_Buffer"),
            contents: bytemuck::cast_slice(vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Path_Index_Buffer"),
            contents: bytemuck::cast_slice(indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Path_Raster_Bind_Group"),
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: self.uniform_buffer.as_entire_binding(),
            }],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Path_Raster_Encoder"),
        });

        {
            let load_op = if clear {
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
            } else {
                wgpu::LoadOp::Load
            };

            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Path_Raster_Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: load_op,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            rpass.set_bind_group(0, &bind_group, &[]);
            rpass.set_vertex_buffer(0, vertex_buffer.slice(..));
            rpass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint16);
            for triangle in (0..indices.len() as u32).step_by(3) {
                rpass.set_pipeline(&self.coverage_pipeline);
                rpass.draw_indexed(triangle..triangle + 3, 0, 0..1);
                rpass.set_pipeline(&self.pipeline);
                rpass.draw_indexed(triangle..triangle + 3, 0, 0..1);
            }
        }

        queue.submit(Some(encoder.finish()));
    }
}

/// Helper: Them dinh va chi so cho hinh chu nhat dac.
pub fn push_rect_vertices(
    vertices: &mut Vec<PathVertex>,
    indices: &mut Vec<u16>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    color: [f32; 4],
    alpha: f32,
) {
    let base_idx = vertices.len() as u16;

    vertices.push(PathVertex::new_flat(x, y, color, alpha));
    vertices.push(PathVertex::new_flat(x + w, y, color, alpha));
    vertices.push(PathVertex::new_flat(x + w, y + h, color, alpha));
    vertices.push(PathVertex::new_flat(x, y + h, color, alpha));

    // 2 tam giac: (0, 1, 2) va (0, 2, 3)
    indices.extend_from_slice(&[
        base_idx,
        base_idx + 1,
        base_idx + 2,
        base_idx,
        base_idx + 2,
        base_idx + 3,
    ]);
}

/// Helper: Them dinh va chi so cho duong cong Bezier bac 2 (Loop-Blinn triangle).
pub fn push_quadratic_bezier_vertices(
    vertices: &mut Vec<PathVertex>,
    indices: &mut Vec<u16>,
    p0: (f32, f32),
    p1: (f32, f32),
    p2: (f32, f32),
    color: [f32; 4],
    alpha: f32,
) {
    let base_idx = vertices.len() as u16;

    // Loop-Blinn parameterization: p0 co (u=0, v=0), p1 co (u=0.5, v=0), p2 co (u=1, v=1)
    vertices.push(PathVertex::new_curve(p0.0, p0.1, 0.0, 0.0, color, alpha));
    vertices.push(PathVertex::new_curve(p1.0, p1.1, 0.5, 0.0, color, alpha));
    vertices.push(PathVertex::new_curve(p2.0, p2.1, 1.0, 1.0, color, alpha));

    indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2]);
}
