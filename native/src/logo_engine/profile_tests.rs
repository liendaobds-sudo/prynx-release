use super::profiles::{trace_core_profile, CoreProfileOptions, CoreProfileOutput};
use super::request::LogoEngineRequest;
use super::scene::{RingRole, SceneGeometry, ScenePath, SceneSegment};

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

fn silhouette_ellipse_request(
    width: usize,
    height: usize,
    radius_x: f64,
    radius_y: f64,
    smoothing: f64,
) -> LogoEngineRequest {
    let center_x = width as f64 * 0.5;
    let center_y = height as f64 * 0.5;
    let mut rgba = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        for x in 0..width {
            let dx = (x as f64 + 0.5 - center_x) / radius_x;
            let dy = (y as f64 + 0.5 - center_y) / radius_y;
            let alpha = if dx * dx + dy * dy <= 1.0 { 255 } else { 0 };
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    LogoEngineRequest::from_legacy_api(width, height, rgba, "monochrome", vec![], smoothing, 0)
        .unwrap()
}
fn antialiased_circle_request(
    size: usize,
    radius: f64,
    center_offset: (f64, f64),
) -> LogoEngineRequest {
    let center_x = size as f64 * 0.5 + center_offset.0;
    let center_y = size as f64 * 0.5 + center_offset.1;
    let mut rgba = Vec::with_capacity(size * size * 4);
    for y in 0..size {
        for x in 0..size {
            let distance = (x as f64 + 0.5 - center_x).hypot(y as f64 + 0.5 - center_y);
            let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
            let alpha = (coverage * 255.0).round() as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    LogoEngineRequest::from_legacy_api(size, size, rgba, "monochrome", vec![], 1.0, 0).unwrap()
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
fn flat_color_curved_shared_boundary_uses_identical_primitive_geometry() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-07): outer của màu trong và hole
    // của màu ngoài phải dùng cùng quỹ đạo, chỉ đảo winding.
    const RED: [u8; 3] = [255, 0, 0];
    const BLUE: [u8; 3] = [0, 0, 255];
    let width = 96;
    let height = 96;
    let center = 48.0;
    let radius = 30.0;
    let mut pixels = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let dx = x as f64 + 0.5 - center;
            let dy = y as f64 + 0.5 - center;
            pixels.push(if dx * dx + dy * dy <= radius * radius {
                RED
            } else {
                BLUE
            });
        }
    }
    let output = trace_core_profile(
        &flat_request_with_options(&pixels, width, height, 1.0, 0),
        CoreProfileOptions::default(),
    )
    .unwrap();

    let mut hole_anchors = None;
    let mut outer_anchor_sets = Vec::new();
    for layer in &output.scene.layers {
        for geometry in &layer.geometry {
            let SceneGeometry::FillRegion { rings } = geometry else {
                continue;
            };
            for ring in rings {
                match ring.role {
                    RingRole::Hole => hole_anchors = Some(canonical_anchor_set(&ring.path)),
                    RingRole::Outer => outer_anchor_sets.push(canonical_anchor_set(&ring.path)),
                }
            }
        }
    }
    let hole_anchors = hole_anchors.expect("fixture phải có hole màu ngoài");
    assert_eq!(hole_anchors.len(), 4);
    assert!(outer_anchor_sets.contains(&hole_anchors));
    assert_eq!(output.metrics.circle_count, 2);
}

#[test]
fn flat_color_freeform_shared_boundary_reuses_exact_reversed_cubics() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-07): a freeform boundary shared
    // by two colors must be fitted once, then reversed exactly for the peer.
    const RED: [u8; 3] = [255, 0, 0];
    const BLUE: [u8; 3] = [0, 0, 255];
    let width = 96;
    let height = 160;
    let mut pixels = Vec::with_capacity(width * height);
    for y in 0..height {
        let phase = std::f64::consts::TAU * y as f64 / 72.0;
        let boundary = (width as f64 * 0.5 + 6.0 * phase.sin()).round() as usize;
        for x in 0..width {
            pixels.push(if x < boundary { RED } else { BLUE });
        }
    }
    let request = flat_request_with_options(&pixels, width, height, 1.0, 0)
        .with_curve_preset(Some("trajectory_completion"))
        .unwrap();
    let output = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();

    let cubic_sets = output
        .scene
        .layers
        .iter()
        .map(|layer| {
            let mut signatures = Vec::new();
            for geometry in &layer.geometry {
                let SceneGeometry::FillRegion { rings } = geometry else {
                    continue;
                };
                for ring in rings {
                    signatures.extend(canonical_cubic_signatures(&ring.path));
                }
            }
            signatures.sort();
            signatures
        })
        .collect::<Vec<_>>();

    assert_eq!(cubic_sets.len(), 2);
    assert!(!cubic_sets[0].is_empty());
    assert_eq!(cubic_sets[0], cubic_sets[1]);
    assert!(output.metrics.max_error_px <= 2.0 + 1e-9);
}

fn canonical_cubic_signatures(path: &ScenePath) -> Vec<[i64; 8]> {
    let quantize = |value: f64| (value * 1_000_000_000.0).round() as i64;
    let mut current = path.start;
    let mut signatures = Vec::new();
    for segment in &path.segments {
        match segment {
            SceneSegment::Line { to } => current = *to,
            SceneSegment::Cubic {
                control_1,
                control_2,
                to,
            } => {
                let forward = [
                    quantize(current.x),
                    quantize(current.y),
                    quantize(control_1.x),
                    quantize(control_1.y),
                    quantize(control_2.x),
                    quantize(control_2.y),
                    quantize(to.x),
                    quantize(to.y),
                ];
                let reverse = [
                    quantize(to.x),
                    quantize(to.y),
                    quantize(control_2.x),
                    quantize(control_2.y),
                    quantize(control_1.x),
                    quantize(control_1.y),
                    quantize(current.x),
                    quantize(current.y),
                ];
                signatures.push(forward.min(reverse));
                current = *to;
            }
        }
    }
    signatures
}

fn canonical_anchor_set(path: &ScenePath) -> Vec<(i64, i64)> {
    let mut anchors = vec![path.start];
    anchors.extend(path.segments.iter().map(SceneSegment::end_point));
    anchors.sort_by_key(|point| {
        (
            (point.x * 1_000_000.0).round() as i64,
            (point.y * 1_000_000.0).round() as i64,
        )
    });
    anchors.dedup_by(|first, second| {
        (first.x - second.x).abs() <= 1e-9 && (first.y - second.y).abs() <= 1e-9
    });
    anchors
        .into_iter()
        .map(|point| {
            (
                (point.x * 1_000_000.0).round() as i64,
                (point.y * 1_000_000.0).round() as i64,
            )
        })
        .collect()
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
fn raster_circle_and_ellipse_are_scale_invariant_compact_curves() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-06): fixture production đi qua
    // contour raster, không dùng circle lượng giác trực tiếp.
    for (width, height, radius_x, radius_y) in [
        (64, 64, 22.0, 22.0),
        (128, 128, 44.0, 44.0),
        (256, 256, 88.0, 88.0),
        (192, 128, 72.0, 40.0),
    ] {
        let request = silhouette_ellipse_request(width, height, radius_x, radius_y, 1.0);
        let output = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();
        let SceneGeometry::FillRegion { rings } = &output.scene.layers[0].geometry[0] else {
            panic!("circle/ellipse phải sinh FillRegion");
        };
        assert_eq!(rings.len(), 1);
        let path = &rings[0].path;
        let line_count = path
            .segments
            .iter()
            .filter(|segment| matches!(segment, SceneSegment::Line { .. }))
            .count();
        assert_eq!(line_count, 0, "Vòng mượt không được lẫn đoạn thẳng");
        assert!(
            (4..=8).contains(&path.node_count()),
            "{}x{} elip còn {} node",
            width,
            height,
            path.node_count()
        );
        assert!(output.metrics.max_error_px <= 1.0 + 1e-9);
    }
}
#[test]
fn antialiased_subpixel_circles_complete_full_trace_with_valid_winding() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-01): contour coverage analytic phải
    // giữ đúng winding qua toàn chuỗi, kể cả khi tâm không nằm trên lưới pixel.
    let size = 32;
    let request = antialiased_circle_request(size, size as f64 * 0.18, (-0.49, -0.49));
    let output = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();

    assert_eq!(output.metrics.outer_count, 1);
    assert_eq!(output.metrics.hole_count, 0);
    assert_eq!(output.metrics.circle_count, 1);
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
