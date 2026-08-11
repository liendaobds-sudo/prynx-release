//! Router hai profile lõi của PrynX Logo Engine v2.

#![allow(dead_code)]

mod flat_color;
mod silhouette;

use super::request::{LogoEngineProfile, LogoEngineRequest};
use super::scene::{EngineProvenance, RingRole, SceneGeometry, VectorScene};
use sha2::{Digest, Sha256};

pub(crate) const CORE_ENGINE_NAME: &str = "prynx-logo-core";
pub(crate) const CORE_ENGINE_VERSION: &str = "0.1.0-dev.1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CoreProfileOptions {
    /// Nhãn palette bị loại khỏi output; chỉ hợp lệ với FlatColor.
    pub(crate) background_label: Option<u16>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProfileMetrics {
    pub(crate) layer_count: usize,
    pub(crate) component_count: usize,
    pub(crate) outer_count: usize,
    pub(crate) hole_count: usize,
    pub(crate) source_nodes: usize,
    pub(crate) output_nodes: usize,
    pub(crate) max_error_px: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CoreProfileOutput {
    pub(crate) scene: VectorScene,
    pub(crate) preprocess_hash: String,
    pub(crate) metrics: ProfileMetrics,
}

pub(crate) fn trace_core_profile(
    request: &LogoEngineRequest,
    options: CoreProfileOptions,
) -> Result<CoreProfileOutput, String> {
    let provenance = EngineProvenance {
        engine: CORE_ENGINE_NAME.to_string(),
        engine_version: CORE_ENGINE_VERSION.to_string(),
        profile: request.profile.as_str().to_string(),
        settings_hash: core_settings_hash(request, options),
    };
    match request.profile {
        LogoEngineProfile::Silhouette => {
            if options.background_label.is_some() {
                return Err("Silhouette không nhận nhãn background palette".to_string());
            }
            silhouette::trace(request, provenance)
        }
        LogoEngineProfile::FlatColor => flat_color::trace(request, provenance, options),
    }
}

fn core_settings_hash(request: &LogoEngineRequest, options: CoreProfileOptions) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"prynx-logo-core-profile-v1");
    hasher.update(request.settings_hash().as_bytes());
    match options.background_label {
        Some(label) => {
            hasher.update([1]);
            hasher.update(label.to_be_bytes());
        }
        None => hasher.update([0]),
    }
    format!("{:x}", hasher.finalize())
}

pub(super) fn summarize_scene(
    scene: &VectorScene,
    component_count: usize,
    source_nodes: usize,
    max_error_px: f64,
) -> ProfileMetrics {
    let mut outer_count = 0;
    let mut hole_count = 0;
    let mut output_nodes = 0;
    for layer in &scene.layers {
        for geometry in &layer.geometry {
            match geometry {
                SceneGeometry::FillRegion { rings } => {
                    for ring in rings {
                        match ring.role {
                            RingRole::Outer => outer_count += 1,
                            RingRole::Hole => hole_count += 1,
                        }
                        output_nodes += ring.path.node_count();
                    }
                }
                SceneGeometry::StrokePath { path, .. } => {
                    output_nodes += path.node_count();
                }
            }
        }
    }
    ProfileMetrics {
        layer_count: scene.layers.len(),
        component_count,
        outer_count,
        hole_count,
        source_nodes,
        output_nodes,
        max_error_px,
    }
}
