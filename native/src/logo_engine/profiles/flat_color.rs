//! Profile flat-color: palette xác nhận → khử hạt → topology → curve-fit.

use super::{summarize_scene, CoreProfileOptions, CoreProfileOutput, PrimitiveCounts};
use crate::logo_engine::contour::{GridPoint, GridRing, CONTOUR_COORDINATE_SCALE};
use crate::logo_engine::curve_fit::{
    fit_closed_ring, fit_shared_open_chain, CurveFitOptions, CurveFitResult, ReconstructedPrimitive,
};
use crate::logo_engine::preprocess::{despeckle_artifact, preprocess_rgba};
use crate::logo_engine::request::LogoEngineRequest;
use crate::logo_engine::scene::{
    CoordinateSystem, EngineProvenance, SceneGeometry, ScenePath, SceneSegment, VectorScene,
    VECTOR_SCENE_VERSION,
};
use crate::logo_engine::topology::build_vector_layers;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

pub(super) fn trace(
    request: &LogoEngineRequest,
    provenance: EngineProvenance,
    options: CoreProfileOptions,
) -> Result<CoreProfileOutput, String> {
    let curve_options =
        curve_options(request.effective_smoothing(), request.prefers_fair_curves())?;
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

    let mut layers = Vec::new();
    let mut ring_inputs = Vec::new();
    for (label, layer) in active_labels.into_iter().zip(raw_layers) {
        if Some(label) == options.background_label {
            continue;
        }
        let layer_index = layers.len();
        for (geometry_index, geometry) in layer.geometry.iter().enumerate() {
            let SceneGeometry::FillRegion { rings } = geometry else {
                return Err("FlatColor chỉ chấp nhận vùng tô kín".to_string());
            };
            for (ring_index, ring) in rings.iter().enumerate() {
                ring_inputs.push(RingInput {
                    layer_index,
                    geometry_index,
                    ring_index,
                    label,
                    grid_ring: scene_path_to_grid_ring(label, &ring.path)?,
                });
            }
        }
        layers.push(layer);
    }
    if layers.is_empty() {
        return Err("Loại background làm output không còn vùng màu logo".to_string());
    }

    // LOGO-TRAJECTORY (audit 2026-08-25 F-07): biên lattice giữa hai nhãn
    // được đăng ký trước khi fit. Một chuỗi chỉ chạy fitter một lần; phía
    // đối diện nhận cùng control và đảo thứ tự, nên không thể sinh seam do
    // Newton–Raphson hội tụ khác nhau.
    let fitted_rings = fit_ring_inputs(&ring_inputs, curve_options)?;
    let mut source_nodes = 0;
    let mut max_error_px = 0.0_f64;
    let mut primitives = PrimitiveCounts::default();
    for (input, fitted) in ring_inputs.iter().zip(fitted_rings) {
        let ring = match &mut layers[input.layer_index].geometry[input.geometry_index] {
            SceneGeometry::FillRegion { rings } => &mut rings[input.ring_index],
            _ => unreachable!("đã kiểm tra FillRegion ở bước thu thập"),
        };
        match fitted.primitive {
            Some(ReconstructedPrimitive::Circle) => primitives.circle += 1,
            Some(ReconstructedPrimitive::Ellipse) => primitives.ellipse += 1,
            None => {}
        }
        source_nodes += fitted.source_nodes;
        max_error_px = max_error_px.max(fitted.max_error_px);
        ring.path = fitted.path;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct BoundaryEdgeKey {
    first: GridPoint,
    second: GridPoint,
}

#[derive(Clone, Debug)]
struct RingInput {
    layer_index: usize,
    geometry_index: usize,
    ring_index: usize,
    label: u16,
    grid_ring: GridRing,
}

#[derive(Clone, Debug)]
struct RingRun {
    start_edge: usize,
    edge_count: usize,
    points: Vec<GridPoint>,
    shared: bool,
    canonical_key: Option<Vec<BoundaryEdgeKey>>,
    reversed_from_canonical: bool,
}

fn fit_ring_inputs(
    inputs: &[RingInput],
    options: CurveFitOptions,
) -> Result<Vec<CurveFitResult>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }

    let mut edge_occurrences = HashMap::<BoundaryEdgeKey, Vec<(usize, u16)>>::new();
    for (ring_index, input) in inputs.iter().enumerate() {
        let vertices = &input.grid_ring.vertices;
        for edge_index in 0..vertices.len() {
            edge_occurrences
                .entry(boundary_edge_key(
                    vertices[edge_index],
                    vertices[(edge_index + 1) % vertices.len()],
                ))
                .or_default()
                .push((ring_index, input.label));
        }
    }

    let mut runs_by_ring = Vec::with_capacity(inputs.len());
    for (ring_index, input) in inputs.iter().enumerate() {
        let shared_flags = input
            .grid_ring
            .vertices
            .iter()
            .enumerate()
            .map(|(edge_index, _)| {
                let key = boundary_edge_key(
                    input.grid_ring.vertices[edge_index],
                    input.grid_ring.vertices[(edge_index + 1) % input.grid_ring.vertices.len()],
                );
                edge_occurrences.get(&key).is_some_and(|occurrences| {
                    occurrences
                        .iter()
                        .any(|(other, label)| *other != ring_index && *label != input.label)
                })
            })
            .collect::<Vec<_>>();
        runs_by_ring.push(build_ring_runs(&input.grid_ring, &shared_flags));
    }

    let mut partial_groups = HashMap::<Vec<BoundaryEdgeKey>, Vec<(usize, usize)>>::new();
    let mut full_groups = HashMap::<Vec<BoundaryEdgeKey>, Vec<(usize, usize)>>::new();
    for (ring_index, runs) in runs_by_ring.iter().enumerate() {
        for (run_index, run) in runs.iter().enumerate() {
            if !run.shared {
                continue;
            }
            if run.edge_count == inputs[ring_index].grid_ring.vertices.len() {
                full_groups
                    .entry(full_edge_set(&inputs[ring_index].grid_ring))
                    .or_default()
                    .push((ring_index, run_index));
            } else if let Some(key) = &run.canonical_key {
                partial_groups
                    .entry(key.clone())
                    .or_default()
                    .push((ring_index, run_index));
            }
        }
    }

    let valid_partial_keys = partial_groups
        .iter()
        .filter_map(|(key, occurrences)| {
            has_distinct_labels(occurrences, inputs).then_some(key.clone())
        })
        .collect::<HashSet<_>>();
    let valid_full_keys = full_groups
        .iter()
        .filter_map(|(key, occurrences)| {
            has_distinct_labels(occurrences, inputs).then_some(key.clone())
        })
        .collect::<HashSet<_>>();

    let mut partial_cache = HashMap::<Vec<BoundaryEdgeKey>, CurveFitResult>::new();
    for key in &valid_partial_keys {
        let Some((ring_index, run_index)) = partial_groups
            .get(key)
            .and_then(|occurrences| occurrences.first())
            .copied()
        else {
            continue;
        };
        let run = &runs_by_ring[ring_index][run_index];
        let canonical_points = if run.reversed_from_canonical {
            run.points.iter().copied().rev().collect::<Vec<_>>()
        } else {
            run.points.clone()
        };
        if let Ok(fitted) = fit_shared_open_chain(&canonical_points, options) {
            partial_cache.insert(key.clone(), fitted);
        }
    }

    let mut full_cache = HashMap::<Vec<BoundaryEdgeKey>, CurveFitResult>::new();
    let mut results = Vec::with_capacity(inputs.len());
    for (ring_index, input) in inputs.iter().enumerate() {
        let full_key = full_edge_set(&input.grid_ring);
        if valid_full_keys.contains(&full_key) {
            let representative = full_groups
                .get(&full_key)
                .and_then(|occurrences| occurrences.first())
                .map(|(index, _)| *index);
            if let Some(representative) = representative {
                let canonical = if let Some(cached) = full_cache.get(&full_key) {
                    Some(cached.clone())
                } else {
                    match fit_closed_ring(&inputs[representative].grid_ring, options) {
                        Ok(fitted) => {
                            full_cache.insert(full_key.clone(), fitted.clone());
                            Some(fitted)
                        }
                        Err(_) => None,
                    }
                };
                if let Some(mut fitted) = canonical {
                    let same_winding = grid_ring_area(&input.grid_ring).signum()
                        == grid_ring_area(&inputs[representative].grid_ring).signum();
                    if !same_winding {
                        fitted.path = reverse_scene_path(&fitted.path);
                    }
                    results.push(fitted);
                    continue;
                }
            }
        }

        let can_assemble_shared = runs_by_ring[ring_index].iter().any(|run| {
            run.shared
                && run.canonical_key.as_ref().is_some_and(|key| {
                    valid_partial_keys.contains(key) && partial_cache.contains_key(key)
                })
        });
        if can_assemble_shared {
            if let Ok(fitted) = assemble_ring_with_shared_runs(
                &inputs[ring_index].grid_ring,
                &runs_by_ring[ring_index],
                &partial_cache,
                &valid_partial_keys,
                options,
            ) {
                results.push(fitted);
                continue;
            }
        }

        // Với contour không có cặp đối diện, giữ nguyên fitter vòng kín đầy đủ
        // để corner detector và primitive recognizer không bị thay đổi.
        results.push(fit_closed_ring(&input.grid_ring, options)?);
    }
    Ok(results)
}

fn build_ring_runs(ring: &GridRing, shared_flags: &[bool]) -> Vec<RingRun> {
    let edge_count = ring.vertices.len();
    if edge_count == 0 {
        return Vec::new();
    }
    let all_shared = shared_flags.iter().all(|shared| *shared);
    let start_edge = if all_shared {
        0
    } else {
        (0..edge_count)
            .find(|index| {
                shared_flags[*index] != shared_flags[(index + edge_count - 1) % edge_count]
            })
            .unwrap_or(0)
    };
    let mut runs = Vec::new();
    let mut consumed = 0;
    while consumed < edge_count {
        let edge_index = (start_edge + consumed) % edge_count;
        let shared = shared_flags[edge_index];
        let mut length = 1;
        while consumed + length < edge_count
            && shared_flags[(start_edge + consumed + length) % edge_count] == shared
        {
            length += 1;
        }
        let mut points = Vec::with_capacity(length + 1);
        let mut edge_keys = Vec::with_capacity(length);
        for offset in 0..=length {
            points.push(ring.vertices[(edge_index + offset) % edge_count]);
            if offset < length {
                edge_keys.push(boundary_edge_key(
                    ring.vertices[(edge_index + offset) % edge_count],
                    ring.vertices[(edge_index + offset + 1) % edge_count],
                ));
            }
        }
        let (canonical_key, reversed_from_canonical) = if shared {
            // Canonical orientation follows the lexicographically smaller endpoint.
            // This also handles a shared chain with exactly one edge, whose
            // undirected edge-key sequence is identical in both directions.
            let reversed_from_canonical =
                compare_grid_points(points[0], points[points.len() - 1]) == Ordering::Greater;
            let canonical_key = if reversed_from_canonical {
                edge_keys.iter().copied().rev().collect::<Vec<_>>()
            } else {
                edge_keys.clone()
            };
            (Some(canonical_key), reversed_from_canonical)
        } else {
            (None, false)
        };
        runs.push(RingRun {
            start_edge: edge_index,
            edge_count: length,
            points,
            shared,
            canonical_key,
            reversed_from_canonical,
        });
        consumed += length;
    }
    runs
}

fn fit_polyline_as_lines(points: &[GridPoint]) -> Result<CurveFitResult, String> {
    if points.len() < 2 {
        return Err("Run bien ngoai can it nhat hai diem".to_string());
    }
    let start = scene_point_from_grid(points[0]);
    let segments = points
        .iter()
        .skip(1)
        .map(|point| SceneSegment::Line {
            to: scene_point_from_grid(*point),
        })
        .collect::<Vec<_>>();
    let path = ScenePath {
        start,
        segments,
        closed: false,
    };
    path.validate()?;
    Ok(CurveFitResult {
        path,
        source_nodes: points.len(),
        simplified_nodes: points.len(),
        output_nodes: points.len(),
        max_error_px: 0.0,
        hard_corner_count: points.len().saturating_sub(2),
        primitive: None,
    })
}

fn scene_point_from_grid(point: GridPoint) -> crate::logo_engine::scene::ScenePoint {
    crate::logo_engine::scene::ScenePoint {
        x: point.x2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
        y: point.y2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
    }
}

fn assemble_ring_with_shared_runs(
    ring: &GridRing,
    runs: &[RingRun],
    shared_cache: &HashMap<Vec<BoundaryEdgeKey>, CurveFitResult>,
    valid_keys: &HashSet<Vec<BoundaryEdgeKey>>,
    options: CurveFitOptions,
) -> Result<CurveFitResult, String> {
    let mut start = None;
    let mut segments = Vec::new();
    let mut max_error_px = 0.0_f64;
    let mut simplified_nodes = 0;
    let mut hard_corner_count = 0;
    for run in runs {
        let fitted = if run.shared {
            if let Some(key) = run
                .canonical_key
                .as_ref()
                .filter(|key| valid_keys.contains(*key))
            {
                if let Some(cached) = shared_cache.get(key) {
                    let mut oriented = cached.clone();
                    if run.reversed_from_canonical {
                        oriented.path = reverse_scene_path(&oriented.path);
                    }
                    oriented
                } else {
                    fit_shared_open_chain(&run.points, options)?
                }
            } else {
                fit_shared_open_chain(&run.points, options)?
            }
        } else {
            // LOGO-TRAJECTORY: non-shared runs may contain real corners.
            // Preserve each lattice edge instead of fitting one cubic across them.
            fit_polyline_as_lines(&run.points)?
        };
        if start.is_none() {
            start = Some(fitted.path.start);
        }
        max_error_px = max_error_px.max(fitted.max_error_px);
        simplified_nodes += fitted.simplified_nodes;
        hard_corner_count += fitted.hard_corner_count;
        segments.extend(fitted.path.segments);
    }
    let start = start.ok_or_else(|| "Contour shared-boundary không có run".to_string())?;
    let path = ScenePath {
        start,
        segments,
        closed: true,
    };
    path.validate()?;
    let output_nodes = path.node_count();
    let end = path
        .segments
        .last()
        .map(SceneSegment::end_point)
        .ok_or_else(|| "Contour shared-boundary không có segment".to_string())?;
    if end != start {
        return Err("Các run shared-boundary không khép đúng điểm nối".to_string());
    }
    Ok(CurveFitResult {
        path,
        source_nodes: ring.vertices.len(),
        simplified_nodes,
        output_nodes,
        max_error_px,
        hard_corner_count,
        primitive: None,
    })
}

fn boundary_edge_key(first: GridPoint, second: GridPoint) -> BoundaryEdgeKey {
    if compare_grid_points(first, second) == Ordering::Greater {
        BoundaryEdgeKey {
            first: second,
            second: first,
        }
    } else {
        BoundaryEdgeKey { first, second }
    }
}

fn full_edge_set(ring: &GridRing) -> Vec<BoundaryEdgeKey> {
    let mut keys = (0..ring.vertices.len())
        .map(|index| {
            boundary_edge_key(
                ring.vertices[index],
                ring.vertices[(index + 1) % ring.vertices.len()],
            )
        })
        .collect::<Vec<_>>();
    keys.sort_by(compare_edge_keys);
    keys
}

fn compare_grid_points(first: GridPoint, second: GridPoint) -> Ordering {
    (first.x2, first.y2).cmp(&(second.x2, second.y2))
}

fn compare_edge_keys(first: &BoundaryEdgeKey, second: &BoundaryEdgeKey) -> Ordering {
    compare_grid_points(first.first, second.first)
        .then_with(|| compare_grid_points(first.second, second.second))
}

fn has_distinct_labels(occurrences: &[(usize, usize)], inputs: &[RingInput]) -> bool {
    occurrences
        .iter()
        .map(|(ring_index, _)| inputs[*ring_index].label)
        .collect::<HashSet<_>>()
        .len()
        >= 2
}

fn grid_ring_area(ring: &GridRing) -> i128 {
    (0..ring.vertices.len())
        .map(|index| {
            let first = ring.vertices[index];
            let second = ring.vertices[(index + 1) % ring.vertices.len()];
            i128::from(first.x2) * i128::from(second.y2)
                - i128::from(second.x2) * i128::from(first.y2)
        })
        .sum()
}

fn reverse_scene_path(path: &ScenePath) -> ScenePath {
    let mut segment_starts = Vec::with_capacity(path.segments.len());
    let mut current = path.start;
    for segment in &path.segments {
        segment_starts.push(current);
        current = segment.end_point();
    }
    let mut reversed_segments = Vec::with_capacity(path.segments.len());
    for index in (0..path.segments.len()).rev() {
        let start = segment_starts[index];
        let segment = &path.segments[index];
        reversed_segments.push(match segment {
            SceneSegment::Line { .. } => SceneSegment::Line { to: start },
            SceneSegment::Cubic {
                control_1,
                control_2,
                ..
            } => SceneSegment::Cubic {
                control_1: *control_2,
                control_2: *control_1,
                to: start,
            },
        });
    }
    ScenePath {
        start: current,
        segments: reversed_segments,
        closed: path.closed,
    }
}

fn curve_options(smoothing: f64, prefer_fair_curves: bool) -> Result<CurveFitOptions, String> {
    if !smoothing.is_finite() || !(0.0..=1.0).contains(&smoothing) {
        return Err("Độ mượt FlatColor phải nằm trong khoảng 0–1".to_string());
    }
    // LOGO-ENGINE-V2 (audit 2026-08-12 Hotfix H2): ngay mức 0 vẫn cho phép
    // sai số tối đa 1 px để bỏ răng cưa raster; mức cao chỉ tăng độ mượt, không
    // thay đổi theo cấu hình máy và không hard-cap số node.
    Ok(CurveFitOptions {
        tolerance_px: 1.0 + smoothing,
        corner_angle_degrees: 55.0 + smoothing * 20.0,
        prefer_fair_curves,
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
