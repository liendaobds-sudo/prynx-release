//! UIUX (audit 2026-09-25 §R25.GPU.30): vùng chọn/markup dùng đúng camera của PDF.
use viewer_gpu::GpuContext;
use wgpu::util::DeviceExt;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlayRect {
    pub bounds: [f32; 4], // x, y, rộng, cao trong pixel vật lý viewport
    pub color: [f32; 4],
    pub multiply: bool,
}
pub struct OverlayPainter {
    normal: wgpu::RenderPipeline,
    multiply: wgpu::RenderPipeline,
    srgb: bool,
}
impl OverlayPainter {
    pub fn new(ctx: &GpuContext, format: wgpu::TextureFormat) -> Self {
        let shader = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("PPE lớp tương tác"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
        let create = |blend| {
            ctx.device
                .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("PPE lớp tương tác"),
                    layout: None,
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("vs"),
                        buffers: &[wgpu::VertexBufferLayout {
                            array_stride: 32,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4],
                        }],
                        compilation_options: Default::default(),
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some("fs"),
                        targets: &[Some(wgpu::ColorTargetState {
                            format,
                            blend: Some(blend),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                        compilation_options: Default::default(),
                    }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview: None,
                    cache: None,
                })
        };
        Self {
            normal: create(wgpu::BlendState::ALPHA_BLENDING),
            multiply: create(wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::Dst,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent::OVER,
            }),
            srgb: format.is_srgb(),
        }
    }
    pub fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        width: u32,
        height: u32,
        rects: &[OverlayRect],
    ) {
        if rects.is_empty() || width == 0 || height == 0 {
            return;
        }
        let mut bytes = Vec::with_capacity(rects.len() * 32);
        for r in rects {
            let b = r.bounds;
            let mut color = r.color;
            if self.srgb {
                for c in &mut color[..3] {
                    *c = if *c <= 0.04045 {
                        *c / 12.92
                    } else {
                        ((*c + 0.055) / 1.055).powf(2.4)
                    };
                }
            }
            // Multiply nhận RGB tuyến tính đã nhân alpha; selection dùng alpha thẳng.
            if r.multiply {
                for c in &mut color[..3] {
                    *c *= r.color[3];
                }
            }
            for value in [
                b[0] / width as f32 * 2. - 1.,
                1. - b[1] / height as f32 * 2.,
                b[2] / width as f32 * 2.,
                -b[3] / height as f32 * 2.,
            ]
            .into_iter()
            .chain(color)
            {
                bytes.extend_from_slice(&value.to_ne_bytes());
            }
        }
        let buffer = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("PPE hình tương tác"),
                contents: &bytes,
                usage: wgpu::BufferUsages::VERTEX,
            });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("PPE selection/markup"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_vertex_buffer(0, buffer.slice(..));
        for (i, r) in rects.iter().enumerate() {
            pass.set_pipeline(if r.multiply {
                &self.multiply
            } else {
                &self.normal
            });
            pass.draw(0..6, i as u32..i as u32 + 1);
        }
    }
}
const SHADER: &str = r#"
struct Out { @builtin(position) pos:vec4f, @location(0) color:vec4f }
@vertex fn vs(@builtin(vertex_index) i:u32,@location(0) bounds:vec4f,@location(1) color:vec4f)->Out {
    let corners=array<vec2f,6>(vec2f(0.,0.),vec2f(0.,1.),vec2f(1.,0.),vec2f(1.,0.),vec2f(0.,1.),vec2f(1.,1.));
    var out:Out;out.pos=vec4f(bounds.xy+corners[i]*bounds.zw,0.,1.);out.color=color;return out;
}
@fragment fn fs(v:Out)->@location(0) vec4f {
    return v.color;
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlay_loads_existing_pixels_and_blends_only_its_bounds() {
        let ctx = GpuContext::new_sync().unwrap();
        let f = wgpu::TextureFormat::Rgba8Unorm;
        let target = ctx.create_target_texture(32, 32, f, None);
        let view = target.create_view(&Default::default());
        let mut e = ctx.device.create_command_encoder(&Default::default());
        {
            let _p = e.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
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
        }
        OverlayPainter::new(&ctx, f).encode(
            &ctx,
            &mut e,
            &view,
            32,
            32,
            &[
                OverlayRect {
                    bounds: [4., 5., 8., 6.],
                    color: [0., 0., 1., 0.5],
                    multiply: false,
                },
                OverlayRect {
                    bounds: [18., 5., 8., 6.],
                    color: [1., 1., 0., 0.5],
                    multiply: true,
                },
            ],
        );
        ctx.queue.submit([e.finish()]);
        let pixels = ctx.readback_texture_rgba8(&target, 32, 32).unwrap();
        let px = |x: usize, y: usize| &pixels[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(px(0, 0), [255, 255, 255, 255]);
        assert_eq!(px(15, 7), [255, 255, 255, 255]);
        assert!((px(8, 7)[0] as i16 - 127).abs() <= 1);
        assert_eq!(px(8, 7)[2], 255);
        assert_eq!(&px(20, 7)[..2], &[255, 255]);
        assert!((px(20, 7)[2] as i16 - 127).abs() <= 1);
    }
}
