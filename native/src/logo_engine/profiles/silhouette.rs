//! Profile silhouette: alpha mask → contour → topology → curve-fit.

use super::{summarize_scene, CoreProfileOutput, PrimitiveCounts};
use crate::logo_engine::contour::{extract_silhouette_contours, GridRing};
use crate::logo_engine::curve_fit::{fit_closed_ring, CurveFitOptions, ReconstructedPrimitive};
use crate::logo_engine::preprocess::preprocess_rgba;
use crate::logo_engine::request::LogoEngineRequest;
use crate::logo_engine::scene::{
    CoordinateSystem, EngineProvenance, FillRing, SceneGeometry, VectorLayer, VectorScene,
    VECTOR_SCENE_VERSION,
};
use crate::logo_engine::topology::classify_contours;

pub(super) fn trace(
    request: &LogoEngineRequest,
    provenance: EngineProvenance,
) -> Result<CoreProfileOutput, String> {
    let curve_options =
        curve_options(request.effective_smoothing(), request.prefers_fair_curves())?;
    let artifact = preprocess_rgba(
        request.width,
        request.height,
        &request.rgba,
        request.profile,
        &request.palette,
    )?;
    let preprocess_hash = artifact.artifact_hash.clone();
    let component_count = artifact.components.len();
    let contours = extract_silhouette_contours(&artifact)?;
    let classified = classify_contours(&contours)?;
    let source_nodes = classified
        .iter()
        .map(|ring| ring.vertices.len())
        .sum::<usize>();
    let mut max_error_px = 0.0_f64;
    let mut primitives = PrimitiveCounts::default();
    let mut rings = Vec::with_capacity(classified.len());

    for ring in classified {
        let fitted = fit_closed_ring(
            &GridRing {
                label_index: ring.label_index,
                vertices: ring.vertices,
                saddle_cuts: ring.saddle_cuts,
            },
            curve_options,
        )?;
        max_error_px = max_error_px.max(fitted.max_error_px);
        match fitted.primitive {
            Some(ReconstructedPrimitive::Circle) => primitives.circle += 1,
            Some(ReconstructedPrimitive::Ellipse) => primitives.ellipse += 1,
            None => {}
        }
        rings.push(FillRing {
            role: ring.role,
            winding: ring.winding,
            path: fitted.path,
        });
    }

    let scene = VectorScene {
        version: VECTOR_SCENE_VERSION,
        width_px: artifact.width_px,
        height_px: artifact.height_px,
        coordinate_system: CoordinateSystem::PixelTopLeft,
        layers: vec![VectorLayer {
            paint: artifact.palette[0],
            geometry: vec![SceneGeometry::FillRegion { rings }],
        }],
        provenance,
    };
    scene.validate_contract()?;
    let metrics = summarize_scene(
        &scene,
        component_count,
        source_nodes,
        max_error_px,
        primitives,
    );
    Ok(CoreProfileOutput {
        scene,
        preprocess_hash,
        metrics,
    })
}

fn curve_options(smoothing: f64, prefer_fair_curves: bool) -> Result<CurveFitOptions, String> {
    if !smoothing.is_finite() || !(0.0..=1.0).contains(&smoothing) {
        return Err("Độ mượt silhouette phải nằm trong khoảng 0–1".to_string());
    }
    // LOGO-ENGINE-V2 (audit 2026-08-11 Lô E): tolerance tăng theo lựa chọn
    // người dùng, không giảm chất lượng theo cấu hình máy hoặc hard-cap ảnh.
    Ok(CurveFitOptions {
        tolerance_px: 0.25 + smoothing * 0.75,
        corner_angle_degrees: 45.0 + smoothing * 20.0,
        prefer_fair_curves,
    })
}
