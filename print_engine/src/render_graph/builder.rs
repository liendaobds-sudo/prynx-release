//! PPE Viewer GPU - Render Graph Builder & Conservative Culling
//!
//! Xay dung Render Graph tu SceneIR cho mot vung nhin cu the (visible_rect).
//! Ap dung conservative bounds culling: loai bo cac doi tuong nam hoan toan ngoai
//! khung nhin, dong thoi bao toan backdrop cua non-isolated groups.

use crate::geom::Rect;
use crate::render_graph::nodes::{BackendTarget, RenderNode, RenderNodeId, RenderPassKind};
use crate::scene::types::{SceneCommand, SceneGroupPush, SceneIR};

#[derive(Debug, Clone)]
pub struct RenderGraph {
    pub nodes: Vec<RenderNode>,
    pub scene_revision: u64,
    pub validation_errors: Vec<String>,
    pub visible_rect: Option<Rect>,
    pub total_nodes: usize,
    pub culled_nodes_count: usize,
}

impl RenderGraph {
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

pub struct RenderGraphBuilder {
    visible_rect: Option<Rect>,
    force_all_nodes: bool,
}

impl RenderGraphBuilder {
    pub fn new() -> Self {
        Self {
            visible_rect: None,
            force_all_nodes: false,
        }
    }

    /// Gioi han do thi trong khung nhin visible_rect (Scene Local Space).
    pub fn with_visible_rect(mut self, visible_rect: Rect) -> Self {
        self.visible_rect = Some(visible_rect);
        self
    }

    /// Bat/tat culling de kiem tra tinh nhat quan (culling vs non-culling identical output).
    pub fn with_force_all_nodes(mut self, force: bool) -> Self {
        self.force_all_nodes = force;
        self
    }

    /// Xay dung Render Graph tu SceneIR.
    pub fn build_from_scene(&self, scene: &SceneIR) -> RenderGraph {
        let mut nodes = Vec::new();
        let mut node_id = 0u64;
        let mut culled_count = 0usize;

        let mut group_stack: Vec<(&SceneGroupPush, RenderNodeId, Option<RenderNodeId>)> =
            Vec::new();
        let mut prev_node_id: Option<RenderNodeId> = None;
        let mut clip_depth = 0usize;
        let mut errors = Vec::new();
        for cmd in &scene.commands {
            let drawing = matches!(
                cmd,
                SceneCommand::Path(_)
                    | SceneCommand::Text(_)
                    | SceneCommand::Image(_)
                    | SceneCommand::Shading(_)
            );
            // PERF (audit 2026-09-25 §R25.GPU.03): state không bị cull; nếu mất
            // clip rỗng ngoài viewport, nội dung con có thể tràn vào viewport.
            if drawing && !self.force_all_nodes && !group_stack.iter().any(|(g, _, _)| !g.isolated)
            {
                if let (Some(vis), Some(bounds)) = (self.visible_rect, cmd.bounds()) {
                    if bounds.intersect(&vis).is_none() {
                        culled_count += 1;
                        continue;
                    }
                }
            }
            node_id += 1;
            let (kind, bounds, fallback) = match cmd {
                SceneCommand::Path(p) => (
                    RenderPassKind::RasterPass {
                        command_id: p.id,
                        overprint: p.overprint,
                    },
                    p.bounds,
                    None,
                ),
                SceneCommand::Text(t) => (
                    RenderPassKind::RasterPass {
                        command_id: t.id,
                        overprint: t.overprint,
                    },
                    t.bounds,
                    Some("Cần phân giải font/glyph"),
                ),
                SceneCommand::Image(i) => (
                    RenderPassKind::RasterPass {
                        command_id: i.id,
                        overprint: false,
                    },
                    i.bounds,
                    Some("Cần resource ảnh và color contract"),
                ),
                SceneCommand::Shading(sh) => (
                    RenderPassKind::RasterPass {
                        command_id: sh.id,
                        overprint: false,
                    },
                    sh.bounds,
                    Some("Cần resource shading"),
                ),
                SceneCommand::PushClip(c) => {
                    clip_depth += 1;
                    (
                        RenderPassKind::ClipPush { command_id: c.id },
                        c.bounds,
                        Some("Clip hình học cần coverage adapter"),
                    )
                }
                SceneCommand::PopClip => {
                    if clip_depth == 0 {
                        errors.push("PopClip thiếu PushClip".into());
                    } else {
                        clip_depth -= 1;
                    }
                    (
                        RenderPassKind::ClipPop,
                        scene.bounds,
                        Some("Khôi phục clip"),
                    )
                }
                SceneCommand::PushGroup(g) => {
                    group_stack.push((g, node_id, prev_node_id));
                    (
                        RenderPassKind::BeginGroup { command_id: g.id },
                        g.bounds,
                        Some("Nhóm cần alpha/shape và backdrop đầy đủ"),
                    )
                }
                SceneCommand::PopGroup => {
                    let Some((g, begin, backdrop)) = group_stack.pop() else {
                        errors.push("PopGroup thiếu PushGroup".into());
                        continue;
                    };
                    let mut node = RenderNode::new(
                        node_id,
                        RenderPassKind::GroupBlendPass {
                            isolated: g.isolated,
                            knockout: g.knockout,
                            blend_mode: g.blend_mode.clone(),
                            alpha: g.alpha,
                        },
                        g.bounds,
                    )
                    .with_backend(
                        BackendTarget::CpuFallback,
                        Some("Nhóm cần alpha/shape và backdrop đầy đủ".into()),
                    );
                    node.inputs.push(begin);
                    if let Some(prev) = prev_node_id {
                        if prev != begin {
                            node.inputs.push(prev);
                        }
                    }
                    if let Some(backdrop) = backdrop {
                        if !node.inputs.contains(&backdrop) {
                            node.inputs.push(backdrop);
                        }
                    }
                    nodes.push(node);
                    prev_node_id = Some(node_id);
                    continue;
                }
            };
            let mut node = RenderNode::new(node_id, kind, bounds);
            if let Some(reason) = fallback {
                node = node.with_backend(BackendTarget::CpuFallback, Some(reason.into()));
            }
            if let Some(prev) = prev_node_id {
                node.inputs.push(prev);
            }
            nodes.push(node);
            prev_node_id = Some(node_id);
        }
        if !group_stack.is_empty() {
            errors.push("Nhóm chưa có PopGroup".into());
        }

        // Them ColorResolvePass lam node cuoi cung
        if !nodes.is_empty() {
            node_id += 1;
            let mut resolve_node = RenderNode::new(
                node_id,
                RenderPassKind::ColorResolvePass {
                    proof_mode: true,
                    overprint_simulation: true,
                },
                scene.bounds,
            )
            .with_backend(
                BackendTarget::CpuFallback,
                Some(
                    "Proof cần ColorManager/profile; shader swatch xấp xỉ chưa đạt hợp đồng".into(),
                ),
            );

            if let Some(prev) = prev_node_id {
                resolve_node.inputs.push(prev);
            }
            nodes.push(resolve_node);
        }

        let total = nodes.len();
        RenderGraph {
            nodes,
            scene_revision: scene.revision,
            validation_errors: errors,
            visible_rect: self.visible_rect,
            total_nodes: total,
            culled_nodes_count: culled_count,
        }
    }
}
