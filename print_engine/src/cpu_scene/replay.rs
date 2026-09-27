//! PPE Viewer GPU - CPU Scene Replay Graph (Milestone G1.4)
//!
//! Thuc thi RenderGraph tren CPU su dung toan bo ha tang kernel goc cua PPE:
//! - Tiny-skia scan-conversion
//! - Rasterizer coverage mask
//! - InkBuffer n-kenh muc trong khong gian [C, M, Y, K, Spot1, ...]
//! - Overprint OPM=1 va blend modes
//!
//! Cung cap doi chung pixel-by-pixel voi interpreter truyen thong (Parity).

use std::collections::HashMap;

use tiny_skia::{LineCap, LineJoin, Mask, PathBuilder, Stroke};

use crate::blend::BlendMode;
use crate::content::RenderOptions;
use crate::error::{PpeError, PpeResult};
use crate::geom::Matrix;
use crate::ink::{ChannelMask, Colorant, InkBuffer, InkPaint, InkSpace};
use crate::raster::mask::{FillRule, Rasterizer};
use crate::render_graph::builder::RenderGraph;
use crate::render_graph::nodes::RenderPassKind;
use crate::scene::path_builder::PathSegment;
use crate::scene::types::{
    SceneColor, SceneColorSpace, SceneCommand, SceneIR, ScenePaintMode, ScenePath,
};

/// Bo thuc thi Render Graph tren CPU (CPU Replay Graph).
pub struct CpuSceneReplayer {
    options: RenderOptions,
}

impl CpuSceneReplayer {
    pub fn new(options: RenderOptions) -> Self {
        Self { options }
    }

    /// Thuc thi RenderGraph va SceneIR ra mot InkBuffer.
    pub fn replay_graph(
        &self,
        scene: &SceneIR,
        graph: &RenderGraph,
        width: u32,
        height: u32,
        device_matrix: Matrix,
    ) -> PpeResult<InkBuffer> {
        if graph.scene_revision != scene.revision || !graph.validation_errors.is_empty() {
            return Err(PpeError::ContentStream(format!(
                "Graph không khớp scene hoặc state không cân: {:?}",
                graph.validation_errors
            )));
        }
        let space = if self.options.flatten_spots {
            InkSpace::preview()
        } else {
            InkSpace::new()
        };

        let mut buffer = InkBuffer::new_with_memory_budget(
            width,
            height,
            space,
            self.options.memory_budget_bytes,
        )?;

        let mut rasterizer = Rasterizer::new(width, height).ok_or(PpeError::BadRasterSize {
            w: width as i64,
            h: height as i64,
            dpi: 72.0,
        })?;

        // Fast lookup map cho command theo command_id
        let cmd_map: HashMap<u64, &SceneCommand> = scene
            .commands
            .iter()
            .filter_map(|cmd| match cmd {
                SceneCommand::Path(p) => Some((p.id, cmd)),
                SceneCommand::Text(t) => Some((t.id, cmd)),
                SceneCommand::Image(img) => Some((img.id, cmd)),
                SceneCommand::Shading(sh) => Some((sh.id, cmd)),
                SceneCommand::PushGroup(g) => Some((g.id, cmd)),
                SceneCommand::PushClip(c) => Some((c.id, cmd)),
                SceneCommand::PopGroup | SceneCommand::PopClip => None,
            })
            .collect();

        // PERF (audit 2026-09-25 §R25.GPU.03): state clip theo thứ tự scene;
        // graph chỉ chọn draw, không được loại bỏ thao tác push/pop state.
        let selected: HashMap<u64, bool> = graph
            .nodes
            .iter()
            .filter_map(|node| match node.kind {
                RenderPassKind::RasterPass {
                    command_id,
                    overprint,
                } => Some((command_id, overprint)),
                _ => None,
            })
            .collect();
        let mut clips: Vec<Mask> = Vec::new();
        for cmd in &scene.commands {
            match cmd {
                SceneCommand::PushClip(c) => {
                    let mut mask = Mask::new(width, height).ok_or(PpeError::BadRasterSize {
                        w: width as i64,
                        h: height as i64,
                        dpi: 72.0,
                    })?;
                    if let Some(path) = scene_device_path(&c.path_data, &device_matrix) {
                        mask.fill_path(
                            &path,
                            if c.even_odd {
                                tiny_skia::FillRule::EvenOdd
                            } else {
                                tiny_skia::FillRule::Winding
                            },
                            self.options.anti_alias,
                            tiny_skia::Transform::identity(),
                        );
                    }
                    if let Some(parent) = clips.last() {
                        for (v, &p) in mask.data_mut().iter_mut().zip(parent.data()) {
                            *v = ((*v as u32 * p as u32 + 127) / 255) as u8;
                        }
                    }
                    clips.push(mask);
                }
                SceneCommand::PopClip => {
                    if clips.pop().is_none() {
                        return Err(PpeError::ContentStream("PopClip thiếu PushClip".into()));
                    }
                }
                SceneCommand::Path(p) => {
                    if let Some(overprint) = selected.get(&p.id) {
                        self.replay_path(
                            p,
                            *overprint,
                            &device_matrix,
                            &mut rasterizer,
                            &mut buffer,
                            clips.last(),
                        )?;
                    }
                }
                SceneCommand::Text(_)
                | SceneCommand::Image(_)
                | SceneCommand::Shading(_)
                | SceneCommand::PushGroup(_)
                | SceneCommand::PopGroup => {
                    return Err(PpeError::Unsupported("CPU scene cần resource/group replay; không được bỏ nội dung rồi trả buffer thành công".into()));
                }
            }
        }
        for id in selected.keys() {
            if !cmd_map.contains_key(id) {
                return Err(PpeError::ContentStream(format!(
                    "Graph tham chiếu command không tồn tại: {id}"
                )));
            }
        }

        Ok(buffer)
    }

    /// Thuc thi rieng mot ScenePath tren rasterizer va composite vao InkBuffer.
    fn replay_path(
        &self,
        p: &ScenePath,
        overprint_override: bool,
        device_matrix: &Matrix,
        rasterizer: &mut Rasterizer,
        buffer: &mut InkBuffer,
        clip: Option<&Mask>,
    ) -> PpeResult<()> {
        let Some(path_data) = &p.path_data else {
            return Ok(());
        };
        if path_data.is_empty() {
            return Ok(());
        }

        let Some(dev_path) = scene_device_path(path_data, device_matrix) else {
            return Ok(());
        };

        let paint = scene_color_to_ink_paint(
            &p.color,
            p.alpha,
            overprint_override || p.overprint,
            buffer.space(),
        )?;

        match p.paint_mode {
            ScenePaintMode::FillNonZero | ScenePaintMode::FillEvenOdd => {
                let rule = match p.paint_mode {
                    ScenePaintMode::FillEvenOdd => FillRule::EvenOdd,
                    _ => FillRule::NonZero,
                };
                let coverage =
                    rasterizer.fill_path(&dev_path, rule, self.options.anti_alias, clip, None);
                if let Some(cov) = coverage {
                    buffer.composite_region(cov.data, cov.region, &paint)?;
                }
            }
            ScenePaintMode::Stroke => {
                let scale = p.transform.then(device_matrix).mean_scale();
                let dev_stroke_width = (p.stroke_width * scale).max(0.5);
                let stroke = Stroke {
                    width: dev_stroke_width,
                    miter_limit: p.miter_limit,
                    line_cap: match p.line_cap {
                        1 => LineCap::Round,
                        2 => LineCap::Square,
                        _ => LineCap::Butt,
                    },
                    line_join: match p.line_join {
                        1 => LineJoin::Round,
                        2 => LineJoin::Bevel,
                        _ => LineJoin::Miter,
                    },
                    dash: None,
                };
                if let Some(outline) = dev_path.stroke(&stroke, 1.0) {
                    let coverage = rasterizer.fill_path(
                        &outline,
                        FillRule::NonZero,
                        self.options.anti_alias,
                        clip,
                        None,
                    );
                    if let Some(cov) = coverage {
                        buffer.composite_region(cov.data, cov.region, &paint)?;
                    }
                }
            }
            ScenePaintMode::FillAndStroke => {
                // Fill truoc
                let coverage = rasterizer.fill_path(
                    &dev_path,
                    FillRule::NonZero,
                    self.options.anti_alias,
                    clip,
                    None,
                );
                if let Some(cov) = coverage {
                    buffer.composite_region(cov.data, cov.region, &paint)?;
                }
                // Stroke sau
                let scale = p.transform.then(device_matrix).mean_scale();
                let dev_stroke_width = (p.stroke_width * scale).max(0.5);
                let stroke = Stroke {
                    width: dev_stroke_width,
                    miter_limit: p.miter_limit,
                    line_cap: LineCap::Butt,
                    line_join: LineJoin::Miter,
                    dash: None,
                };
                if let Some(outline) = dev_path.stroke(&stroke, 1.0) {
                    let coverage = rasterizer.fill_path(
                        &outline,
                        FillRule::NonZero,
                        self.options.anti_alias,
                        clip,
                        None,
                    );
                    if let Some(cov) = coverage {
                        buffer.composite_region(cov.data, cov.region, &paint)?;
                    }
                }
            }
            ScenePaintMode::Clip => {}
        }

        Ok(())
    }
}

/// Chuyen doi SceneColor sang InkPaint cua PPE voi overprint mode OPM=1 va participation mask.
pub fn scene_color_to_ink_paint(
    color: &SceneColor,
    alpha: f32,
    overprint: bool,
    space: &InkSpace,
) -> PpeResult<InkPaint> {
    Ok(match &color.space {
        SceneColorSpace::DeviceCMYK => {
            let mut ink = vec![0.0f32; space.len()];
            let c = color
                .components
                .first()
                .copied()
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            let m = color
                .components
                .get(1)
                .copied()
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            let y = color
                .components
                .get(2)
                .copied()
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            let k = color
                .components
                .get(3)
                .copied()
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            if ink.len() >= 4 {
                ink[0] = c;
                ink[1] = m;
                ink[2] = y;
                ink[3] = k;
            }
            let mut paint = InkPaint {
                ink,
                declared: ChannelMask::PROCESS,
                overprint,
                alpha: alpha.clamp(0.0, 1.0),
                blend: BlendMode::Normal,
                blend_rgb: None,
            };
            if overprint {
                paint = paint.with_overprint_mode_1();
            }
            paint
        }
        SceneColorSpace::DeviceGray => {
            let mut ink = vec![0.0f32; space.len()];
            let gray = color
                .components
                .first()
                .copied()
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            let k = (1.0 - gray).clamp(0.0, 1.0);
            if ink.len() >= 4 {
                ink[3] = k;
            }
            let mut paint = InkPaint {
                ink,
                declared: ChannelMask::single(3),
                overprint,
                alpha: alpha.clamp(0.0, 1.0),
                blend: BlendMode::Normal,
                blend_rgb: None,
            };
            if overprint {
                paint = paint.with_overprint_mode_1();
            }
            paint
        }
        SceneColorSpace::DeviceRGB => {
            return Err(PpeError::Unsupported("Scene RGB cần ColorManager/profile; không được đổi sang CMYK bằng công thức xấp xỉ".into()));
        }
        SceneColorSpace::Separation { name, .. } => {
            let mut ink = vec![0.0f32; space.len()];
            let tint = color
                .components
                .first()
                .copied()
                .unwrap_or(1.0)
                .clamp(0.0, 1.0);
            let colorant = Colorant::from_pdf_name(name);
            if let Some(idx) = space.index_of(&colorant) {
                if idx < ink.len() {
                    ink[idx] = tint;
                }
                let mut paint = InkPaint {
                    ink,
                    declared: ChannelMask::single(idx),
                    overprint,
                    alpha: alpha.clamp(0.0, 1.0),
                    blend: BlendMode::Normal,
                    blend_rgb: None,
                };
                if overprint {
                    paint = paint.with_overprint_mode_1();
                }
                paint
            } else {
                return Err(PpeError::Unsupported(format!(
                    "Scene thiếu colorant {name}; không thay spot bằng mực đen"
                )));
            }
        }
        _ => {
            return Err(PpeError::Unsupported(
                "Scene cần phân giải ICC/DeviceN/Pattern bằng PPE có resources".into(),
            ))
        }
    })
}

fn scene_device_path(
    data: &crate::scene::path_builder::ScenePathData,
    device_matrix: &Matrix,
) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    for sp in &data.subpaths {
        for seg in &sp.segments {
            match seg {
                PathSegment::MoveTo(pt) => {
                    let (x, y) = device_matrix.apply(pt.x, pt.y);
                    pb.move_to(x, y);
                }
                PathSegment::LineTo(pt) => {
                    let (x, y) = device_matrix.apply(pt.x, pt.y);
                    pb.line_to(x, y);
                }
                PathSegment::CubicTo { cp1, cp2, to } => {
                    let (x1, y1) = device_matrix.apply(cp1.x, cp1.y);
                    let (x2, y2) = device_matrix.apply(cp2.x, cp2.y);
                    let (x3, y3) = device_matrix.apply(to.x, to.y);
                    pb.cubic_to(x1, y1, x2, y2, x3, y3);
                }
                PathSegment::Close => {
                    pb.close();
                }
            }
        }
    }
    pb.finish()
}
