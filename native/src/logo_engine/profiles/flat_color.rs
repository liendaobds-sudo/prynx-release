//! Profile flat-color giữ biên chung chính xác theo cutout palette.

use super::{summarize_scene, CoreProfileOptions, CoreProfileOutput};
use crate::logo_engine::preprocess::preprocess_rgba;
use crate::logo_engine::request::LogoEngineRequest;
use crate::logo_engine::scene::{
    CoordinateSystem, EngineProvenance, SceneGeometry, VectorScene, VECTOR_SCENE_VERSION,
};
use crate::logo_engine::topology::build_vector_layers;

pub(super) fn trace(
    request: &LogoEngineRequest,
    provenance: EngineProvenance,
    options: CoreProfileOptions,
) -> Result<CoreProfileOutput, String> {
    let artifact = preprocess_rgba(
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

    let preprocess_hash = artifact.artifact_hash.clone();
    let active_labels = artifact
        .label_pixel_counts
        .iter()
        .enumerate()
        .filter_map(|(label, count)| (*count > 0).then_some(label as u16))
        .collect::<Vec<_>>();
    let layers = build_vector_layers(&artifact)?;
    if active_labels.len() != layers.len() {
        return Err("Số layer contour không khớp số nhãn màu hoạt động".to_string());
    }
    let layers = active_labels
        .into_iter()
        .zip(layers)
        .filter_map(|(label, layer)| (Some(label) != options.background_label).then_some(layer))
        .collect::<Vec<_>>();
    if layers.is_empty() {
        return Err("Loại background làm output không còn vùng màu logo".to_string());
    }

    // LOGO-ENGINE-V2 (audit 2026-08-11 Lô E): FlatColor chưa curve-fit
    // từng màu độc lập; giữ line chung chính xác để không sinh khe do làm tròn.
    let source_nodes = layers
        .iter()
        .flat_map(|layer| &layer.geometry)
        .map(|geometry| match geometry {
            SceneGeometry::FillRegion { rings } => rings
                .iter()
                .map(|ring| ring.path.node_count())
                .sum::<usize>(),
            SceneGeometry::StrokePath { path, .. } => path.node_count(),
        })
        .sum::<usize>();
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
    let metrics = summarize_scene(&scene, component_count, source_nodes, 0.0);
    Ok(CoreProfileOutput {
        scene,
        preprocess_hash,
        metrics,
    })
}
