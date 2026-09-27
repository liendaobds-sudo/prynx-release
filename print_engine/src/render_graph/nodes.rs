//! PPE Viewer GPU - Render Graph Node Types
//!
//! Dac ta cac node va pass trong do thi render (Render Graph v1).
//! Ho tro raster pass, group blend, soft mask (alpha/luminosity), va color resolve.

use crate::geom::Rect;

pub type RenderNodeId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendTarget {
    GpuShader,
    GpuBlit,
    CpuFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoftMaskType {
    Alpha,
    Luminosity,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RenderPassKind {
    /// State hình học, không phải ảnh soft-mask: giữ đủ push/pop trong graph.
    ClipPush {
        command_id: u64,
    },
    ClipPop,
    /// Bắt đầu surface nhóm; GroupBlendPass chỉ chạy khi kết thúc nội dung nhóm.
    BeginGroup {
        command_id: u64,
    },
    /// Pass tao coverage va raster cho vector/text/image
    RasterPass {
        command_id: u64,
        overprint: bool,
    },
    /// Nhom hoa tron transparency group
    GroupBlendPass {
        isolated: bool,
        knockout: bool,
        blend_mode: String,
        alpha: f32,
    },
    /// Mat na mem Soft Mask
    SoftMaskPass {
        mask_type: SoftMaskType,
        has_backdrop: bool,
    },
    /// Resolve mau ra swapchain man hinh (CMYK + Spot -> Display RGB)
    ColorResolvePass {
        proof_mode: bool,
        overprint_simulation: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderNode {
    pub id: RenderNodeId,
    pub kind: RenderPassKind,
    pub bounds: Rect,
    pub inputs: Vec<RenderNodeId>,
    pub backend: BackendTarget,
    pub fallback_reason: Option<String>,
}

impl RenderNode {
    pub fn new(id: RenderNodeId, kind: RenderPassKind, bounds: Rect) -> Self {
        Self {
            id,
            kind,
            bounds,
            inputs: Vec::new(),
            backend: BackendTarget::GpuShader,
            fallback_reason: None,
        }
    }

    pub fn with_input(mut self, input_id: RenderNodeId) -> Self {
        self.inputs.push(input_id);
        self
    }

    pub fn with_backend(mut self, backend: BackendTarget, reason: Option<String>) -> Self {
        self.backend = backend;
        self.fallback_reason = reason;
        self
    }
}
