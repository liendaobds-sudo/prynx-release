//! PPE Viewer GPU - Capability Planner (Milestone G2.5)
//!
//! Danh gia nang luc GPU, kiem tra limits va phan loai cac pass trong Render Graph:
//! - GpuPipeline: vector path, image sampling, group blend, soft mask, color resolve.
//! - CpuFallback: kich thuoc vuot max_texture_dimension, mesh shading chua ho tro GPU,
//!   hoac ky tu Type3 chua raster.

use crate::device::GpuContext;

/// Muc tieu thuc thi cho mot pass
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuBackendTarget {
    /// Thuc thi truc tiep bang GPU shader pipeline
    GpuPipeline,
    /// Chuyen sang CPU fallback kernel roi upload ket qua len GPU
    CpuFallback,
}

/// Ly do chuyen sang CPU fallback
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FallbackReason {
    pub pass_name: String,
    pub reason: String,
}

/// Bo lap ke hoach phan bo tai nguyen va phan loai render pass
pub struct CapabilityPlanner {
    pub max_texture_dimension_2d: u32,
    pub supports_rgba16f_render: bool,
    pub adapter_name: String,
    pub backend_name: String,
}

impl CapabilityPlanner {
    pub fn new(ctx: &GpuContext) -> Self {
        let limits = ctx.device.limits();
        let info = &ctx.adapter_info;

        Self {
            max_texture_dimension_2d: limits.max_texture_dimension_2d,
            supports_rgba16f_render: {
                let features = ctx
                    .adapter
                    .get_texture_format_features(wgpu::TextureFormat::Rgba16Float);
                features.allowed_usages.contains(
                    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                ) && features.flags.contains(
                    wgpu::TextureFormatFeatureFlags::BLENDABLE
                        | wgpu::TextureFormatFeatureFlags::FILTERABLE,
                )
            },
            adapter_name: info.name.clone(),
            backend_name: format!("{:?}", info.backend),
        }
    }

    /// Kiem tra xem mot texture co vuot qua gioi han kich thuoc cua GPU khong
    pub fn can_support_texture_size(&self, width: u32, height: u32) -> bool {
        width > 0
            && height > 0
            && width <= self.max_texture_dimension_2d
            && height <= self.max_texture_dimension_2d
    }

    /// Phan loai pass: quyet dinh GpuPipeline hay CpuFallback
    pub fn plan_pass(
        &self,
        pass_name: &str,
        width: u32,
        height: u32,
        is_exotic_primitive: bool,
    ) -> (GpuBackendTarget, Option<FallbackReason>) {
        // PERF (audit 2026-09-25 §R25.GPU.07): thăm dò adapter thật, không suy từ máy phát triển.
        if !self.supports_rgba16f_render {
            return (
                GpuBackendTarget::CpuFallback,
                Some(FallbackReason {
                    pass_name: pass_name.into(),
                    reason: "GPU không hỗ trợ surface RGBA16F render/blend/sample".into(),
                }),
            );
        }
        // 1. Kiem tra gioi han kich thuoc
        if !self.can_support_texture_size(width, height) {
            return (
                GpuBackendTarget::CpuFallback,
                Some(FallbackReason {
                    pass_name: pass_name.to_string(),
                    reason: format!(
                        "Kich thuoc texture ({}x{}) vuot qua gioi han toi da cua GPU ({})",
                        width, height, self.max_texture_dimension_2d
                    ),
                }),
            );
        }

        // 2. Kiem tra primitive hiem (vd: Type3 font chua co outline hoac Tensor mesh shading)
        if is_exotic_primitive {
            return (
                GpuBackendTarget::CpuFallback,
                Some(FallbackReason {
                    pass_name: pass_name.to_string(),
                    reason: "Primitive chua ho tro GPU pipeline (chuyen CPU kernel xu ly)"
                        .to_string(),
                }),
            );
        }

        // 3. Toan bo cac pass vector, image, group blend, soft mask, resolve deu di duong GPU
        (GpuBackendTarget::GpuPipeline, None)
    }
}
