//! PPE Viewer GPU - Native Viewport Module (Milestone G3)
//!
//! Chua toan bo ha tang Viewport Native tren Windows:
//! - ViewportController: Camera native, anchor zoom, toa do 4 cap
//! - Win32ChildViewport: Child HWND, surface swapchain, bat su kien chuot native
//! - commands: Tauri IPC commands cho React frontend

pub mod commands;
pub mod controller;
pub mod page_layout;
pub mod scheduler;
pub mod scene_worker;
pub(crate) mod scene_cache;
mod presenter;
mod detail_cache;
mod refinement;
mod interaction;
mod overlay;
mod window_region;
mod document_renderer;
#[cfg(windows)]
mod visibility;
#[cfg(windows)]
pub mod win32_host;

pub use commands::*;
pub use controller::{CameraSnapshot, ViewportController};
pub use page_layout::{DocumentLayout, PageGeometry, PageLayoutMode};
pub use scheduler::ViewportScheduler;
#[cfg(windows)]
pub use win32_host::Win32ChildViewport;
