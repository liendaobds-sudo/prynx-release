use super::profiles::{trace_core_profile, CoreProfileOptions, CoreProfileOutput};
use super::request::LogoEngineRequest;
use super::scene::{RingRole, SceneGeometry, SceneSegment};

fn silhouette_request(rows: &[&str]) -> LogoEngineRequest {
    let width = rows[0].len();
    let mut rgba = Vec::with_capacity(width * rows.len() * 4);
    for row in rows {
        assert_eq!(row.len(), width);
        for pixel in row.bytes() {
            match pixel {
                b'#' => rgba.extend_from_slice(&[0, 0, 0, 255]),
                b'.' => rgba.extend_from_slice(&[0, 0, 0, 0]),
                _ => panic!("fixture profile chỉ nhận # hoặc ."),
            }
        }
    }
    LogoEngineRequest::from_legacy_api(width, rows.len(), rgba, "monochrome", vec![], 0.5, 0)
        .unwrap()
}

fn flat_request(colors: &[[u8; 3]], width: usize, height: usize) -> LogoEngineRequest {
    flat_request_with_options(colors, width, height, 0.5, 0)
}

fn flat_request_with_options(
    colors: &[[u8; 3]],
    width: usize,
    height: usize,
    smoothing: f64,
    despeckle_size_px: usize,
) -> LogoEngineRequest {
    assert_eq!(colors.len(), width * height);
    let mut rgba = Vec::with_capacity(colors.len() * 4);
    for color in colors {
        rgba.extend_from_slice(&[color[0], color[1], color[2], 255]);
    }
    let mut unique = Vec::<[u8; 3]>::new();
    for color in colors {
        if !unique.contains(color) {
            unique.push(*color);
        }
    }
    let palette = unique
        .iter()
        .map(|color| format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2]))
        .collect();
    LogoEngineRequest::from_legacy_api(
        width,
        height,
        rgba,
        "fixed_palette",
        palette,
        smoothing,
        despeckle_size_px,
    )
    .unwrap()
}

fn trace_silhouette(rows: &[&str]) -> CoreProfileOutput {
    trace_core_profile(&silhouette_request(rows), CoreProfileOptions::default()).unwrap()
}

#[test]
fn silhouette_preserves_counter_and_scene_contract() {
    let output = trace_silhouette(&[
        "#######", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#######",
    ]);

    assert_eq!(output.metrics.layer_count, 1);
    assert_eq!(output.metrics.outer_count, 1);
    assert_eq!(output.metrics.hole_count, 1);
    assert!(output.metrics.max_error_px <= 0.625);
    assert!(output.scene.validate_contract().is_ok());
    let SceneGeometry::FillRegion { rings } = &output.scene.layers[0].geometry[0] else {
        panic!("silhouette phải sinh FillRegion");
    };
    assert!(rings.iter().any(|ring| ring.role == RingRole::Hole));
}

#[test]
fn silhouette_keeps_detached_vietnamese_accent_component() {
    let output = trace_silhouette(&[
        "..##...", ".......", ".......", "..###..", "..###..", "..###..", "..###..", "..###..",
    ]);

    assert_eq!(output.metrics.component_count, 2);
    assert_eq!(output.metrics.outer_count, 2);
    assert_eq!(output.metrics.hole_count, 0);
}

#[test]
fn flat_color_supports_2_4_8_and_12_confirmed_colors() {
    let palette = [
        [230, 25, 75],
        [60, 180, 75],
        [255, 225, 25],
        [0, 130, 200],
        [245, 130, 48],
        [145, 30, 180],
        [70, 240, 240],
        [240, 50, 230],
        [210, 245, 60],
        [250, 190, 212],
        [0, 128, 128],
        [220, 190, 255],
    ];

    for color_count in [2, 4, 8, 12] {
        let request = flat_request(&palette[..color_count], color_count, 1);
        let output = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();

        assert_eq!(output.metrics.layer_count, color_count);
        assert_eq!(output.metrics.component_count, color_count);
        assert_eq!(output.metrics.max_error_px, 0.0);
        assert!(output.scene.validate_contract().is_ok());
    }
}

#[test]
fn flat_color_removes_explicit_background_label() {
    const RED: [u8; 3] = [255, 0, 0];
    const WHITE: [u8; 3] = [255, 255, 255];
    let mut pixels = vec![WHITE; 25];
    for y in 1..4 {
        for x in 1..4 {
            pixels[y * 5 + x] = RED;
        }
    }
    let request = flat_request(&pixels, 5, 5);
    let without_background = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();
    let output = trace_core_profile(
        &request,
        CoreProfileOptions {
            background_label: Some(0),
        },
    )
    .unwrap();

    assert_eq!(output.metrics.layer_count, 1);
    assert_eq!(output.scene.layers[0].paint.rgba, [255, 0, 0, 255]);
    assert_eq!(output.metrics.outer_count, 1);
    assert_eq!(output.metrics.hole_count, 0);
    assert_ne!(
        output.scene.provenance.settings_hash,
        without_background.scene.provenance.settings_hash
    );
}

#[test]
fn flat_color_keeps_shared_boundaries_as_exact_lines() {
    const RED: [u8; 3] = [255, 0, 0];
    const BLUE: [u8; 3] = [0, 0, 255];
    let request = flat_request(&[RED, RED, BLUE, BLUE, RED, RED, BLUE, BLUE], 4, 2);
    let output = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();

    assert_eq!(output.scene.layers.len(), 2);
    assert!(output.scene.layers.iter().all(|layer| {
        layer.geometry.iter().all(|geometry| match geometry {
            SceneGeometry::FillRegion { rings } => rings.iter().all(|ring| {
                ring.path
                    .segments
                    .iter()
                    .all(|segment| matches!(segment, SceneSegment::Line { .. }))
            }),
            SceneGeometry::StrokePath { .. } => false,
        })
    }));
    assert!(output
        .scene
        .layers
        .iter()
        .all(|layer| layer_has_vertical_boundary(layer, 2.0)));
}

#[test]
fn flat_color_despeckle_removes_isolated_color_component() {
    const RED: [u8; 3] = [255, 0, 0];
    const BLUE: [u8; 3] = [0, 0, 255];
    let mut pixels = vec![BLUE; 81];
    for y in 2..7 {
        for x in 2..7 {
            pixels[y * 9 + x] = RED;
        }
    }
    pixels[0] = RED;

    let raw = trace_core_profile(
        &flat_request_with_options(&pixels, 9, 9, 0.0, 0),
        CoreProfileOptions::default(),
    )
    .unwrap();
    let cleaned = trace_core_profile(
        &flat_request_with_options(&pixels, 9, 9, 0.0, 2),
        CoreProfileOptions::default(),
    )
    .unwrap();

    assert_eq!(raw.metrics.component_count, 3);
    assert_eq!(raw.metrics.outer_count, 3);
    assert_eq!(cleaned.metrics.component_count, 2);
    assert_eq!(cleaned.metrics.outer_count, 2);
    assert_ne!(raw.preprocess_hash, cleaned.preprocess_hash);
    assert!(cleaned.scene.validate_contract().is_ok());
}

#[test]
fn flat_color_curve_fit_reduces_jagged_palette_boundary() {
    const RED: [u8; 3] = [255, 0, 0];
    const BLUE: [u8; 3] = [0, 0, 255];
    const OFFSETS: [isize; 8] = [0, 1, 2, 1, 0, -1, -2, -1];
    let width = 96;
    let height = 160;
    let mut pixels = Vec::with_capacity(width * height);
    for y in 0..height {
        let boundary = (width as isize / 2 + OFFSETS[y % OFFSETS.len()]) as usize;
        for x in 0..width {
            pixels.push(if x < boundary { RED } else { BLUE });
        }
    }
    let output = trace_core_profile(
        &flat_request_with_options(&pixels, width, height, 1.0, 0),
        CoreProfileOptions::default(),
    )
    .unwrap();

    assert!(
        output.metrics.output_nodes * 2 < output.metrics.source_nodes,
        "curve-fit phải giảm node: {} -> {}",
        output.metrics.source_nodes,
        output.metrics.output_nodes
    );
    assert!(output.metrics.max_error_px <= 2.0 + 1e-9);
    assert!(output.scene.validate_contract().is_ok());
}

#[test]
fn profile_output_is_deterministic() {
    let request = silhouette_request(&["#####", "#...#", "#####", "#....", "#...."]);
    let first = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();
    let second = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.preprocess_hash.len(), 64);
    assert_eq!(first.scene.provenance.profile, "silhouette");
    assert_eq!(first.scene.provenance.settings_hash.len(), 64);
}

#[test]
fn invalid_background_contract_fails_closed() {
    let silhouette = silhouette_request(&["#"]);
    assert!(trace_core_profile(
        &silhouette,
        CoreProfileOptions {
            background_label: Some(0),
        },
    )
    .unwrap_err()
    .contains("Silhouette"));

    let flat = flat_request(&[[255, 255, 255]], 1, 1);
    assert!(trace_core_profile(
        &flat,
        CoreProfileOptions {
            background_label: Some(0),
        },
    )
    .unwrap_err()
    .contains("không còn"));
}

fn layer_has_vertical_boundary(layer: &super::scene::VectorLayer, x: f64) -> bool {
    layer.geometry.iter().any(|geometry| {
        let SceneGeometry::FillRegion { rings } = geometry else {
            return false;
        };
        rings.iter().any(|ring| {
            let mut start = ring.path.start;
            for segment in &ring.path.segments {
                let end = segment.end_point();
                if start.x == x && end.x == x && start.y != end.y {
                    return true;
                }
                start = end;
            }
            ring.path.closed
                && start.x == x
                && ring.path.start.x == x
                && start.y != ring.path.start.y
        })
    })
}
