//! Profile flat-color: palette xác nhận → khử hạt → topology → curve-fit.

use super::{summarize_scene, CoreProfileOptions, CoreProfileOutput};
use crate::logo_engine::contour::{GridPoint, GridRing, CONTOUR_COORDINATE_SCALE};
use crate::logo_engine::curve_fit::{fit_closed_ring, CurveFitOptions};
use crate::logo_engine::preprocess::{despeckle_artifact, preprocess_rgba};
use crate::logo_engine::request::LogoEngineRequest;
use crate::logo_engine::scene::{
    CoordinateSystem, EngineProvenance, SceneGeometry, ScenePath, SceneSegment, VectorScene,
    VECTOR_SCENE_VERSION,
};
use crate::logo_engine::topology::build_vector_layers;

pub(super) fn trace(
    request: &LogoEngineRequest,
    provenance: EngineProvenance,
    options: CoreProfileOptions,
) -> Result<CoreProfileOutput, String> {
    let curve_options = curve_options(request.smoothing)?;
    let mut artifact = preprocess_rgba(
        request.width,
        request.height,
        &request.rgba,
        request.profile,
        &request.palette,
    )?;
    if options
        .background_label
        .is_some_and(|label| usize::from(label) >= artifact.palette.len())
    {
        return Err("Nhãn background nằm ngoài palette".to_string());
    }
    despeckle_artifact(&mut artifact, request.profile, request.despeckle_size_px)?;

    let preprocess_hash = artifact.artifact_hash.clone();
    let active_labels = artifact
        .label_pixel_counts
        .iter()
        .enumerate()
        .filter_map(|(label, count)| (*count > 0).then_some(label as u16))
        .collect::<Vec<_>>();
    let raw_layers = build_vector_layers(&artifact)?;
    if active_labels.len() != raw_layers.len() {
        return Err("Số layer contour không khớp số nhãn màu hoạt động".to_string());
    }

    let mut source_nodes = 0;
    let mut max_error_px = 0.0_f64;
    let mut layers = Vec::new();
    for (label, mut layer) in active_labels.into_iter().zip(raw_layers) {
        if Some(label) == options.background_label {
            continue;
        }
        for geometry in &mut layer.geometry {
            let SceneGeometry::FillRegion { rings } = geometry else {
                return Err("FlatColor chỉ chấp nhận vùng tô kín".to_string());
            };
            for ring in rings {
                let grid_ring = scene_path_to_grid_ring(label, &ring.path)?;
                let fitted = fit_closed_ring(&grid_ring, curve_options)?;
                source_nodes += fitted.source_nodes;
                max_error_px = max_error_px.max(fitted.max_error_px);
                ring.path = fitted.path;
            }
        }
        layers.push(layer);
    }
    if layers.is_empty() {
        return Err("Loại background làm output không còn vùng màu logo".to_string());
    }

    let component_count = artifact
        .components
        .iter()
        .filter(|component| Some(component.label_index) != options.background_label)
        .count();
    let scene = VectorScene {
        version: VECTOR_SCENE_VERSION,
        width_px: artifact.width_px,
        height_px: artifact.height_px,
        coordinate_system: CoordinateSystem::PixelTopLeft,
        layers,
        provenance,
    };
    scene.validate_contract()?;
    let metrics = summarize_scene(&scene, component_count, source_nodes, max_error_px);
    Ok(CoreProfileOutput {
        scene,
        preprocess_hash,
        metrics,
    })
}

fn curve_options(smoothing: f64) -> Result<CurveFitOptions, String> {
    if !smoothing.is_finite() || !(0.0..=1.0).contains(&smoothing) {
        return Err("Độ mượt FlatColor phải nằm trong khoảng 0–1".to_string());
    }
    // LOGO-ENGINE-V2 (audit 2026-08-12 Hotfix H2): ngay mức 0 vẫn cho phép
    // sai số tối đa 1 px để bỏ răng cưa raster; mức cao chỉ tăng độ mượt, không
    // thay đổi theo cấu hình máy và không hard-cap số node.
    Ok(CurveFitOptions {
        tolerance_px: 1.0 + smoothing,
        corner_angle_degrees: 55.0 + smoothing * 20.0,
    })
}

fn scene_path_to_grid_ring(label_index: u16, path: &ScenePath) -> Result<GridRing, String> {
    if !path.closed {
        return Err("FlatColor nhận đường contour chưa khép kín".to_string());
    }
    let mut vertices = vec![scene_point_to_grid(path.start.x, path.start.y)?];
    for segment in &path.segments {
        let SceneSegment::Line { to } = segment else {
            return Err("Contour FlatColor đầu vào không được chứa cubic".to_string());
        };
        vertices.push(scene_point_to_grid(to.x, to.y)?);
    }
    if vertices.last() == vertices.first() {
        vertices.pop();
    }
    if vertices.len() < 3 {
        return Err("Contour FlatColor cần ít nhất ba đỉnh".to_string());
    }
    Ok(GridRing {
        label_index,
        vertices,
        saddle_cuts: 0,
    })
}

fn scene_point_to_grid(x: f64, y: f64) -> Result<GridPoint, String> {
    fn scale(value: f64) -> Result<i64, String> {
        let scaled = value * CONTOUR_COORDINATE_SCALE as f64;
        if !scaled.is_finite()
            || scaled < i64::MIN as f64
            || scaled > i64::MAX as f64
            || (scaled - scaled.round()).abs() > 1e-9
        {
            return Err("Tọa độ contour FlatColor lệch khỏi lưới half-pixel".to_string());
        }
        Ok(scaled.round() as i64)
    }
    Ok(GridPoint {
        x2: scale(x)?,
        y2: scale(y)?,
    })
}
