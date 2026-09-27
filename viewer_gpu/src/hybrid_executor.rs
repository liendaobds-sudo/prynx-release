//! PPE Viewer GPU - Hybrid GPU/CPU Graph Executor (Milestone G2.5)
//!
//! Bo dieu phoi thuc thi do thi render lai:
//! - Ket hop cac pipeline GPU (Vector Path, Image Sampling, Group Blend, Soft Mask, Resolve)
//! - Cung cap co che fallback an toan: nhan du lieu raster tu CPU fallback kernel va upload len GPU
//! - Bao toan backdrop va truyen state chinh xac giua cac pass

use crate::capability::{CapabilityPlanner, FallbackReason};
use crate::color_resolve::{ColorResolvePipeline, ResolveUniforms};
use crate::device::GpuContext;
use crate::group_blend::{GroupBlendPipeline, GroupBlendUniforms, SoftMaskPipeline};
use crate::image_pipeline::ImageSamplePipeline;
use crate::path_raster::{push_rect_vertices, PathRasterPipeline, PathUniforms};
use crate::resource_pool::{GpuResourcePool, LeasedTexture};

/// Bao cao ket qua thuc thi do thi render
#[derive(Debug, Clone, Default)]
pub struct ExecutionSummary {
    pub total_passes: usize,
    pub gpu_passes: usize,
    pub fallback_passes: usize,
    pub fallbacks: Vec<FallbackReason>,
}

/// Bo dieu phoi thuc thi do thi render lai (Hybrid Executor)
pub struct HybridGraphExecutor {
    pub planner: CapabilityPlanner,
    pub raster_pipeline: PathRasterPipeline,
    pub blend_pipeline: GroupBlendPipeline,
    pub soft_mask_pipeline: SoftMaskPipeline,
    pub image_pipeline: ImageSamplePipeline,
    pub resolve_pipeline: ColorResolvePipeline,
    pub resource_pool: GpuResourcePool,
}

impl HybridGraphExecutor {
    pub fn new(ctx: &GpuContext, target_format: wgpu::TextureFormat) -> Self {
        let planner = CapabilityPlanner::new(ctx);
        let raster_pipeline = PathRasterPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
        let blend_pipeline = GroupBlendPipeline::new(&ctx.device, &ctx.queue, wgpu::TextureFormat::Rgba16Float);
        let soft_mask_pipeline = SoftMaskPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
        let image_pipeline = ImageSamplePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
        let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, target_format);
        let resource_pool = GpuResourcePool::new();

        Self {
            planner,
            raster_pipeline,
            blend_pipeline,
            soft_mask_pipeline,
            image_pipeline,
            resolve_pipeline,
            resource_pool,
        }
    }

    /// Muon intermediate texture tu resource pool
    pub fn lease_surface(&self, ctx: &GpuContext, width: u32, height: u32, label: Option<&str>) -> LeasedTexture {
        self.resource_pool.lease_intermediate(&ctx.device, width, height, label)
    }

    /// Thuc thi pass ve hinh chu nhat vector tren GPU
    pub fn execute_vector_rect(
        &self,
        ctx: &GpuContext,
        target_view: &wgpu::TextureView,
        viewport_w: u32,
        viewport_h: u32,
        rect: [f32; 4],
        cmyk: [f32; 4],
        clear: bool,
    ) {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        push_rect_vertices(
            &mut vertices,
            &mut indices,
            rect[0],
            rect[1],
            rect[2],
            rect[3],
            cmyk,
            1.0,
        );

        let uniforms = PathUniforms {
            viewport_width: viewport_w as f32,
            viewport_height: viewport_h as f32,
            device_scale: 1.0,
            _pad: 0.0,
        };

        self.raster_pipeline.render(
            &ctx.device,
            &ctx.queue,
            target_view,
            &vertices,
            &indices,
            &uniforms,
            clear,
        );
    }

    /// Upload du lieu tu CPU fallback kernel len intermediate texture
    pub fn upload_cpu_fallback_cmyk(
        &self,
        ctx: &GpuContext,
        texture: &wgpu::Texture,
        width: u32,
        height: u32,
        f16_data: &[u8],
    ) {
        ctx.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            f16_data,
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
    }

    /// Thuc thi hoa tron transparency group tren GPU
    pub fn execute_group_blend(
        &self,
        ctx: &GpuContext,
        backdrop_view: &wgpu::TextureView,
        source_view: &wgpu::TextureView,
        mask_view: Option<&wgpu::TextureView>,
        target_view: &wgpu::TextureView,
        uniforms: &GroupBlendUniforms,
    ) {
        self.blend_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            backdrop_view,
            source_view,
            mask_view,
            target_view,
            uniforms,
        );
    }

    /// Thuc thi Color Resolve pass cuoi cung sang target display surface
    pub fn execute_color_resolve(
        &self,
        ctx: &GpuContext,
        input_view: &wgpu::TextureView,
        target_view: &wgpu::TextureView,
        uniforms: &ResolveUniforms,
    ) {
        self.resolve_pipeline.execute(
            &ctx.device,
            &ctx.queue,
            input_view,
            target_view,
            uniforms,
        );
    }
}
