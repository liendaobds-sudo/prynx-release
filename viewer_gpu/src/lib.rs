//! # PPE Viewer GPU
//!
//! Native GPU Pixel Pipeline (DirectX 12 / Vulkan qua wgpu 24).
//! Cung cap ha tang render GPU toc do cao cho PDF prepress:
//! - Intermediate Rgba16Float rendering attachment cho CMYK/Spot
//! - Color resolve shader sang Display sRGB / Bgra8
//! - Soft mask va transparency group compositing

pub mod capability;
pub mod color_resolve;
pub mod device;
pub mod group_blend;
pub mod hybrid_executor;
pub mod image_pipeline;
pub mod path_raster;
pub mod resource_pool;
pub mod ink_surface;
pub mod icc_resolve;
pub mod retained_material;
pub mod retained_renderer;
pub mod resident_present;
pub mod timing;
mod retained_fallback;

pub use capability::{CapabilityPlanner, FallbackReason, GpuBackendTarget};
pub use color_resolve::{ColorResolvePipeline, ResolveUniforms};
pub use device::{GpuContext, GpuError};
pub use group_blend::{
    BlendModeGpu, ColorSpaceGpu, GroupBlendPipeline, GroupBlendUniforms, SoftMaskPipeline,
    SoftMaskTypeGpu, SoftMaskUniforms,
};
pub use hybrid_executor::{ExecutionSummary, HybridGraphExecutor};
pub use image_pipeline::{
    create_unit_quad_vertices, ImageSamplePipeline, ImageUniforms, ImageVertex,
};
pub use path_raster::{
    push_quadratic_bezier_vertices, push_rect_vertices, PathRasterPipeline, PathUniforms,
    PathVertex,
};
pub use resource_pool::{GpuResourcePool, LeasedTexture, PoolStats};
