use super::profiles::{trace_core_profile, CoreProfileOptions};
use super::qc::{inspect_svg_artifact, inspect_svg_artifact_cancellable, ArtifactQcOptions};
use super::request::LogoEngineRequest;
use super::scene::{
    EngineProvenance, FillRing, RingRole, SceneGeometry, ScenePath, ScenePoint, SceneSegment,
    SolidPaint, VectorLayer, VectorScene, Winding,
};
use super::svg_writer::{write_svg, PhysicalSizeMm, SvgWriteOptions};

// LOGO-ENGINE-V2 (audit 2026-08-11 Lô F): chốt artifact SVG cuối bằng
// round-trip parser/raster độc lập, không chỉ kiểm cấu trúc VectorScene nội bộ.

fn provenance() -> EngineProvenance {
    EngineProvenance {
        engine: "prynx-logo-core".to_string(),
        engine_version: "test".to_string(),
        profile: "flat_color".to_string(),
        settings_hash: "fixture".to_string(),
    }
}

fn rectangle_path(left: f64, top: f64, right: f64, bottom: f64, clockwise: bool) -> ScenePath {
    let (start, points) = if clockwise {
        (
            ScenePoint { x: left, y: top },
            [
                ScenePoint { x: right, y: top },
                ScenePoint {
                    x: right,
                    y: bottom,
                },
                ScenePoint { x: left, y: bottom },
            ],
        )
    } else {
        (
            ScenePoint { x: left, y: top },
            [
                ScenePoint { x: left, y: bottom },
                ScenePoint {
                    x: right,
                    y: bottom,
                },
                ScenePoint { x: right, y: top },
            ],
        )
    };
    ScenePath {
        start,
        segments: points
            .into_iter()
            .map(|to| SceneSegment::Line { to })
            .collect(),
        closed: true,
    }
}

fn rectangle_scene(width_px: u32, height_px: u32) -> VectorScene {
    let mut scene = VectorScene::empty(width_px, height_px, provenance());
    scene.layers.push(VectorLayer {
        paint: SolidPaint {
            rgba: [30, 90, 180, 255],
        },
        geometry: vec![SceneGeometry::FillRegion {
            rings: vec![FillRing {
                role: RingRole::Outer,
                winding: Winding::Clockwise,
                path: rectangle_path(0.0, 0.0, f64::from(width_px), f64::from(height_px), true),
            }],
        }],
    });
    scene
}

fn flat_color_fixture() -> (VectorScene, Vec<u8>) {
    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];
    let pixels = [RED, RED, BLUE, BLUE, RED, RED, BLUE, BLUE];
    let rgba = pixels.into_iter().flatten().collect::<Vec<_>>();
    let request = LogoEngineRequest::from_legacy_api(
        4,
        2,
        rgba.clone(),
        "fixed_palette",
        vec!["#ff0000".to_string(), "#0000ff".to_string()],
        0.5,
        0,
    )
    .unwrap();
    let output = trace_core_profile(&request, CoreProfileOptions::default()).unwrap();
    (output.scene, rgba)
}

fn striped_fixture(width_px: u32, height_px: u32) -> (VectorScene, Vec<u8>) {
    let paint = SolidPaint {
        rgba: [30, 90, 180, 255],
    };
    let rings = (0..width_px)
        .step_by(2)
        .map(|x| FillRing {
            role: RingRole::Outer,
            winding: Winding::Clockwise,
            path: rectangle_path(
                f64::from(x),
                0.0,
                f64::from(x + 1),
                f64::from(height_px),
                true,
            ),
        })
        .collect::<Vec<_>>();
    let mut scene = VectorScene::empty(width_px, height_px, provenance());
    scene.layers.push(VectorLayer {
        paint,
        geometry: vec![SceneGeometry::FillRegion { rings }],
    });
    let mut reference = vec![0_u8; width_px as usize * height_px as usize * 4];
    for y in 0..height_px as usize {
        for x in (0..width_px as usize).step_by(2) {
            let offset = (y * width_px as usize + x) * 4;
            reference[offset..offset + 4].copy_from_slice(&paint.rgba);
        }
    }
    (scene, reference)
}

#[test]
fn flat_color_round_trip_matches_reference_exactly() {
    let (scene, reference) = flat_color_fixture();
    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let report = inspect_svg_artifact(
        &artifact.svg,
        &scene,
        Some(&reference),
        ArtifactQcOptions {
            min_iou: Some(1.0),
            max_mae: Some(0.0),
            ..ArtifactQcOptions::default()
        },
    )
    .unwrap();

    assert_eq!(report.iou, Some(1.0));
    assert_eq!(report.mae, Some(0.0));
    assert_eq!(report.outer_count, 2);
    assert_eq!(report.hole_count, 0);
}

#[test]
fn detailed_fill_qc_uses_scanlines_and_matches_reference() {
    // PERF (audit 2026-08-11 §LOGO-QC.01): 128 dải tạo 512 cạnh.
    // Rasterizer cũ kiểm 512 cạnh cho từng pixel scale 4× nên ca này là
    // regression trực tiếp cho preview chạy mãi ở ảnh logo thật.
    let (scene, reference) = striped_fixture(256, 64);
    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let report = inspect_svg_artifact(
        &artifact.svg,
        &scene,
        Some(&reference),
        ArtifactQcOptions {
            min_iou: Some(1.0),
            max_mae: Some(0.0),
            ..ArtifactQcOptions::default()
        },
    )
    .unwrap();

    assert_eq!(report.iou, Some(1.0));
    assert_eq!(report.mae, Some(0.0));
    assert_eq!(report.outer_count, 128);
}

#[test]
fn qc_cancel_is_observed_inside_scanline_phase() {
    let (scene, reference) = striped_fixture(256, 64);
    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let mut checks = 0_usize;
    let error = inspect_svg_artifact_cancellable(
        &artifact.svg,
        &scene,
        Some(&reference),
        ArtifactQcOptions::default(),
        &mut || {
            checks += 1;
            checks > 12
        },
    )
    .unwrap_err();

    assert!(checks > 12);
    assert!(error.contains("hủy QC artifact"));
}

#[test]
fn physical_size_round_trip_keeps_mm_contract() {
    let scene = rectangle_scene(4, 2);
    let physical = PhysicalSizeMm {
        width_mm: 40.0,
        height_mm: 20.0,
    };
    let artifact = write_svg(
        &scene,
        SvgWriteOptions {
            physical_size_mm: Some(physical),
            max_output_bytes: None,
        },
    )
    .unwrap();
    let report = inspect_svg_artifact(
        &artifact.svg,
        &scene,
        None,
        ArtifactQcOptions {
            expected_physical_size_mm: Some(physical),
            ..ArtifactQcOptions::default()
        },
    )
    .unwrap();

    assert_eq!(report.physical_size_mm, Some(physical));
    assert!(artifact.svg.contains("width=\"40mm\" height=\"20mm\""));
}

#[test]
fn counter_keeps_outer_and_hole_winding() {
    let mut scene = VectorScene::empty(4, 4, provenance());
    scene.layers.push(VectorLayer {
        paint: SolidPaint {
            rgba: [0, 0, 0, 255],
        },
        geometry: vec![SceneGeometry::FillRegion {
            rings: vec![
                FillRing {
                    role: RingRole::Outer,
                    winding: Winding::Clockwise,
                    path: rectangle_path(0.0, 0.0, 4.0, 4.0, true),
                },
                FillRing {
                    role: RingRole::Hole,
                    winding: Winding::CounterClockwise,
                    path: rectangle_path(1.0, 1.0, 3.0, 3.0, false),
                },
            ],
        }],
    });

    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let mut reference = vec![0_u8; 4 * 4 * 4];
    for y in 0..4 {
        for x in 0..4 {
            if !(1..3).contains(&x) || !(1..3).contains(&y) {
                let offset = (y * 4 + x) * 4;
                reference[offset..offset + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    }
    let report = inspect_svg_artifact(
        &artifact.svg,
        &scene,
        Some(&reference),
        ArtifactQcOptions::default(),
    )
    .unwrap();

    assert!(artifact.svg.contains("fill-rule=\"nonzero\""));
    assert_eq!((report.outer_count, report.hole_count), (1, 1));
    assert_eq!(report.iou, Some(1.0));
    assert_eq!(report.mae, Some(0.0));
}

#[test]
fn cubic_segment_is_written_as_c_command() {
    let mut scene = VectorScene::empty(4, 2, provenance());
    scene.layers.push(VectorLayer {
        paint: SolidPaint {
            rgba: [0, 0, 0, 255],
        },
        geometry: vec![SceneGeometry::StrokePath {
            path: ScenePath {
                start: ScenePoint { x: 0.0, y: 1.0 },
                segments: vec![SceneSegment::Cubic {
                    control_1: ScenePoint { x: 1.0, y: 0.0 },
                    control_2: ScenePoint { x: 3.0, y: 2.0 },
                    to: ScenePoint { x: 4.0, y: 1.0 },
                }],
                closed: false,
            },
            width_px: 0.5,
        }],
    });

    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();

    assert!(artifact.svg.contains("d=\"M 0 1 C 1 0 3 2 4 1\""));
    inspect_svg_artifact(&artifact.svg, &scene, None, ArtifactQcOptions::default()).unwrap();
}

#[test]
fn output_and_hash_are_deterministic() {
    let scene = rectangle_scene(4, 2);
    let first = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let second = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let report =
        inspect_svg_artifact(&first.svg, &scene, None, ArtifactQcOptions::default()).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.sha256, report.artifact_sha256);
    assert_eq!(first.byte_len, report.byte_len);
    assert_eq!(first.sha256.len(), 64);
}

#[test]
fn writer_rejects_empty_scene_nan_and_wrong_mm_ratio() {
    let empty = VectorScene::empty(4, 2, provenance());
    assert!(write_svg(&empty, SvgWriteOptions::default())
        .unwrap_err()
        .contains("rỗng"));

    let mut nan_scene = rectangle_scene(4, 2);
    let SceneGeometry::FillRegion { rings } = &mut nan_scene.layers[0].geometry[0] else {
        unreachable!();
    };
    rings[0].path.start.x = f64::NAN;
    assert!(write_svg(&nan_scene, SvgWriteOptions::default())
        .unwrap_err()
        .contains("không hữu hạn"));

    assert!(write_svg(
        &rectangle_scene(4, 2),
        SvgWriteOptions {
            physical_size_mm: Some(PhysicalSizeMm {
                width_mm: 40.0,
                height_mm: 25.0,
            }),
            max_output_bytes: None,
        },
    )
    .unwrap_err()
    .contains("Tỷ lệ"));
}

#[test]
fn caller_budgets_reject_output_input_and_raster() {
    let (scene, reference) = flat_color_fixture();
    assert!(write_svg(
        &scene,
        SvgWriteOptions {
            physical_size_mm: None,
            max_output_bytes: Some(1),
        },
    )
    .unwrap_err()
    .contains("ngân sách caller"));

    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    assert!(inspect_svg_artifact(
        &artifact.svg,
        &scene,
        None,
        ArtifactQcOptions {
            max_input_bytes: Some(artifact.byte_len - 1),
            ..ArtifactQcOptions::default()
        },
    )
    .unwrap_err()
    .contains("ngân sách caller"));

    assert!(inspect_svg_artifact(
        &artifact.svg,
        &scene,
        Some(&reference),
        ArtifactQcOptions {
            max_raster_pixels: Some(4 * 2 * 4 * 4 - 1),
            ..ArtifactQcOptions::default()
        },
    )
    .unwrap_err()
    .contains("ngân sách caller"));
}

#[test]
fn qc_rejects_wrong_physical_confirmation_and_nan() {
    let scene = rectangle_scene(4, 2);
    let physical = PhysicalSizeMm {
        width_mm: 40.0,
        height_mm: 20.0,
    };
    let artifact = write_svg(
        &scene,
        SvgWriteOptions {
            physical_size_mm: Some(physical),
            max_output_bytes: None,
        },
    )
    .unwrap();
    assert!(inspect_svg_artifact(
        &artifact.svg,
        &scene,
        None,
        ArtifactQcOptions {
            expected_physical_size_mm: Some(PhysicalSizeMm {
                width_mm: 40.0,
                height_mm: 21.0,
            }),
            ..ArtifactQcOptions::default()
        },
    )
    .unwrap_err()
    .contains("không khớp"));

    let nan_svg = artifact.svg.replacen("M 0 0", "M NaN 0", 1);
    assert!(inspect_svg_artifact(
        &nan_svg,
        &scene,
        None,
        ArtifactQcOptions {
            expected_physical_size_mm: Some(physical),
            ..ArtifactQcOptions::default()
        },
    )
    .unwrap_err()
    .contains("NaN"));
}

#[test]
fn qc_accepts_nonadjacent_shared_endpoint_without_crossing() {
    let mut scene = VectorScene::empty(2, 2, provenance());
    scene.layers.push(VectorLayer {
        paint: SolidPaint {
            rgba: [0, 0, 0, 255],
        },
        geometry: vec![SceneGeometry::StrokePath {
            path: ScenePath {
                start: ScenePoint { x: 0.0, y: 0.0 },
                segments: vec![
                    SceneSegment::Line {
                        to: ScenePoint { x: 2.0, y: 0.0 },
                    },
                    SceneSegment::Line {
                        to: ScenePoint { x: 1.0, y: 1.0 },
                    },
                    SceneSegment::Line {
                        to: ScenePoint { x: 0.0, y: 0.0 },
                    },
                    SceneSegment::Line {
                        to: ScenePoint { x: 0.0, y: 2.0 },
                    },
                ],
                closed: false,
            },
            width_px: 0.25,
        }],
    });

    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();

    inspect_svg_artifact(&artifact.svg, &scene, None, ArtifactQcOptions::default()).unwrap();
}

#[test]
fn open_polyline_does_not_create_phantom_closing_join() {
    let mut scene = VectorScene::empty(4, 2, provenance());
    scene.layers.push(VectorLayer {
        paint: SolidPaint {
            rgba: [0, 0, 0, 255],
        },
        geometry: vec![SceneGeometry::StrokePath {
            path: ScenePath {
                start: ScenePoint { x: 0.0, y: 1.0 },
                segments: vec![
                    SceneSegment::Line {
                        to: ScenePoint { x: 2.0, y: 1.0 },
                    },
                    SceneSegment::Line {
                        to: ScenePoint { x: 4.0, y: 1.0 },
                    },
                ],
                closed: false,
            },
            width_px: 0.5,
        }],
    });

    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let report =
        inspect_svg_artifact(&artifact.svg, &scene, None, ArtifactQcOptions::default()).unwrap();

    assert_eq!(report.max_artifact_tangent_jump_degrees, 0.0);
}

#[test]
fn qc_reports_max_tangent_jump_from_final_svg() {
    let scene = rectangle_scene(4, 2);
    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();

    let report =
        inspect_svg_artifact(&artifact.svg, &scene, None, ArtifactQcOptions::default()).unwrap();

    assert!((report.max_artifact_tangent_jump_degrees - 90.0).abs() < 1.0e-6);
}

#[test]
fn qc_rejects_bow_tie_after_svg_parse() {
    let scene = rectangle_scene(4, 2);
    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let tampered = artifact
        .svg
        .replace("M 0 0 L 4 0 L 4 2 L 0 2 Z", "M 0 0 L 4 2 L 4 0 L 0 2 Z");

    let error =
        inspect_svg_artifact(&tampered, &scene, None, ArtifactQcOptions::default()).unwrap_err();

    assert!(error.contains("tự giao cắt"), "{error}");
}

#[test]
fn qc_rejects_cubic_loop_after_svg_parse() {
    let scene = rectangle_scene(16, 16);
    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();
    let tampered = artifact.svg.replace(
        "M 0 0 L 16 0 L 16 16 L 0 16 Z",
        "M 0 0 C 10 10 -10 10 8 0 Z",
    );

    let error =
        inspect_svg_artifact(&tampered, &scene, None, ArtifactQcOptions::default()).unwrap_err();

    assert!(error.contains("tự giao cắt"), "{error}");
}

#[test]
fn qc_rejects_tampered_view_box_and_topology() {
    let scene = rectangle_scene(4, 2);
    let artifact = write_svg(&scene, SvgWriteOptions::default()).unwrap();

    let wrong_view_box = artifact
        .svg
        .replace("viewBox=\"0 0 4 2\"", "viewBox=\"0 0 5 2\"");
    assert!(
        inspect_svg_artifact(&wrong_view_box, &scene, None, ArtifactQcOptions::default(),)
            .unwrap_err()
            .contains("viewBox")
    );

    let wrong_topology = artifact
        .svg
        .replace("M 0 0 L 4 0 L 4 2 L 0 2 Z", "M 0 0 L 0 2 L 4 2 L 4 0 Z");
    assert_ne!(wrong_topology, artifact.svg);
    assert!(
        inspect_svg_artifact(&wrong_topology, &scene, None, ArtifactQcOptions::default(),)
            .unwrap_err()
            .contains("Topology")
    );
}
