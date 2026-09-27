//! PPE Viewer GPU - CPU Replay Graph Module (Milestone G1.4)
//!
//! Module thuc thi Render Graph tren CPU bang cac kernel hien co cua PPE:
//! tiny-skia scan-convert, InkBuffer n-kenh muc, OPM=1 overprint, va color resolve.

pub mod replay;

pub use replay::{scene_color_to_ink_paint, CpuSceneReplayer};
