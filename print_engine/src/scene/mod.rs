//! PPE Viewer GPU - Scene Module
//!
//! Chua dac ta Scene IR, SceneCompiler va SceneCamera bat bien theo Camera/Zoom.

pub mod compiler;
pub mod form_scope;
pub mod invalidation;
pub mod path_builder;
pub mod spatial_index;
pub mod types;
pub mod retained;
pub mod wire;

pub use compiler::SceneCompiler;
pub use form_scope::{FormInvocationScopeManager, InvocationKey};
pub use invalidation::{InvalidationLevel, SceneRevisionTracker};
pub use path_builder::{PathBuilder, PathSegment, ScenePathData, ScenePoint, SceneSubpath};
pub use spatial_index::{SpatialIndex, SpatialItem};
pub use types::{
    SceneCamera, SceneClipPush, SceneColor, SceneColorSpace, SceneCommand, SceneGroupPush,
    SceneIR, SceneImage, ScenePageBoxes, ScenePaintMode, ScenePath, SceneShading,
    SceneTextRun,
};
