//! Router hai profile lõi của PrynX Logo Engine v2.

#![allow(dead_code)]

mod flat_color;
mod silhouette;

use super::request::{LogoEngineProfile, LogoEngineRequest};
use super::scene::{
    EngineProvenance, RingRole, SceneGeometry, ScenePath, ScenePoint, SceneSegment, VectorScene,
};
use sha2::{Digest, Sha256};

pub(crate) const CORE_ENGINE_NAME: &str = "prynx-logo-core";
pub(crate) const CORE_ENGINE_VERSION: &str = "0.2.0-dev.1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CoreProfileOptions {
    /// Nhãn palette bị loại khỏi output; chỉ hợp lệ với FlatColor.
    pub(crate) background_label: Option<u16>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct PrimitiveCounts {
    pub(super) circle: usize,
    pub(super) ellipse: usize,
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
    pub(crate) line_segments: usize,
    pub(crate) cubic_segments: usize,
    pub(crate) circle_count: usize,
    pub(crate) ellipse_count: usize,
    pub(crate) max_smooth_tangent_jump_degrees: f64,
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
    primitives: PrimitiveCounts,
) -> ProfileMetrics {
    let mut outer_count = 0;
    let mut hole_count = 0;
    let mut output_nodes = 0;
    let mut line_segments = 0;
    let mut cubic_segments = 0;
    let mut max_smooth_tangent_jump_degrees = 0.0_f64;
    for layer in &scene.layers {
        for geometry in &layer.geometry {
            match geometry {
                SceneGeometry::FillRegion { rings } => {
                    for ring in rings {
                        match ring.role {
                            RingRole::Outer => outer_count += 1,
                            RingRole::Hole => hole_count += 1,
                        }
                        accumulate_path_metrics(
                            &ring.path,
                            &mut output_nodes,
                            &mut line_segments,
                            &mut cubic_segments,
                            &mut max_smooth_tangent_jump_degrees,
                        );
                    }
                }
                SceneGeometry::StrokePath { path, .. } => {
                    accumulate_path_metrics(
                        path,
                        &mut output_nodes,
                        &mut line_segments,
                        &mut cubic_segments,
                        &mut max_smooth_tangent_jump_degrees,
                    );
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
        line_segments,
        cubic_segments,
        circle_count: primitives.circle,
        ellipse_count: primitives.ellipse,
        max_smooth_tangent_jump_degrees,
    }
}

fn accumulate_path_metrics(
    path: &ScenePath,
    output_nodes: &mut usize,
    line_segments: &mut usize,
    cubic_segments: &mut usize,
    max_tangent_jump: &mut f64,
) {
    *output_nodes += path.node_count();
    for segment in &path.segments {
        match segment {
            SceneSegment::Line { .. } => *line_segments += 1,
            SceneSegment::Cubic { .. } => *cubic_segments += 1,
        }
    }
    for pair in path.segments.windows(2) {
        *max_tangent_jump = (*max_tangent_jump).max(cubic_join_angle(&pair[0], &pair[1]));
    }
    if path.closed && path.segments.len() > 1 {
        *max_tangent_jump = (*max_tangent_jump).max(cubic_join_angle(
            path.segments.last().expect("path đã có segment"),
            &path.segments[0],
        ));
    }
}

fn cubic_join_angle(previous: &SceneSegment, next: &SceneSegment) -> f64 {
    let SceneSegment::Cubic {
        control_2,
        to: join,
        ..
    } = previous
    else {
        return 0.0;
    };
    let SceneSegment::Cubic { control_1, .. } = next else {
        return 0.0;
    };
    let incoming = vector(*control_2, *join);
    let outgoing = vector(*join, *control_1);
    let denominator = incoming.0.hypot(incoming.1) * outgoing.0.hypot(outgoing.1);
    if denominator <= 1e-12 {
        return 180.0;
    }
    ((incoming.0 * outgoing.0 + incoming.1 * outgoing.1) / denominator)
        .clamp(-1.0, 1.0)
        .acos()
        .to_degrees()
}

fn vector(from: ScenePoint, to: ScenePoint) -> (f64, f64) {
    (to.x - from.x, to.y - from.y)
}
