//! PPE Viewer GPU - Render Graph Module
//!
//! Quan ly do thi cac pass dung hinh, dependency tracking va conservative culling.

pub mod builder;
pub mod nodes;

pub use builder::{RenderGraph, RenderGraphBuilder};
pub use nodes::{BackendTarget, RenderNode, RenderNodeId, RenderPassKind, SoftMaskType};
