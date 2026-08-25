use super::contour::{GridPoint, GridRing, CONTOUR_COORDINATE_SCALE};
use super::curve_fit::{
    fit_closed_ring, fit_open_with_tangents, CurveFitOptions, ReconstructedPrimitive,
};
use super::scene::{ScenePath, ScenePoint, SceneSegment};
use super::simplify::FitPoint;

fn options(tolerance_px: f64) -> CurveFitOptions {
    CurveFitOptions {
        tolerance_px,
        corner_angle_degrees: 55.0,
        prefer_fair_curves: false,
    }
}

fn trajectory_options(tolerance_px: f64) -> CurveFitOptions {
    CurveFitOptions {
        prefer_fair_curves: true,
        ..options(tolerance_px)
    }
}

fn grid_ring(points: &[(f64, f64)]) -> GridRing {
    GridRing {
        label_index: 0,
        vertices: points
            .iter()
            .map(|&(x, y)| GridPoint {
                x2: (x * CONTOUR_COORDINATE_SCALE as f64).round() as i64,
                y2: (y * CONTOUR_COORDINATE_SCALE as f64).round() as i64,
            })
            .collect(),
        saddle_cuts: 0,
    }
}

fn cubic_point(
    start: FitPoint,
    control_1: FitPoint,
    control_2: FitPoint,
    end: FitPoint,
    parameter: f64,
) -> FitPoint {
    let inverse = 1.0 - parameter;
    start
        .scale(inverse * inverse * inverse)
        .add(control_1.scale(3.0 * parameter * inverse * inverse))
        .add(control_2.scale(3.0 * parameter * parameter * inverse))
        .add(end.scale(parameter * parameter * parameter))
}

fn endpoint_signed_area(path: &ScenePath) -> f64 {
    let mut points = vec![path.start];
    points.extend(path.segments.iter().map(|segment| match segment {
        SceneSegment::Line { to } | SceneSegment::Cubic { to, .. } => *to,
    }));
    points
        .windows(2)
        .map(|pair| pair[0].x * pair[1].y - pair[1].x * pair[0].y)
        .sum::<f64>()
        * 0.5
}

fn assert_closed_cubics_are_g1(path: &ScenePath) {
    let mut cubics = Vec::with_capacity(path.segments.len());
    let mut from = path.start;
    for segment in &path.segments {
        let SceneSegment::Cubic {
            control_1,
            control_2,
            to,
        } = segment
        else {
            panic!("Primitive tròn/elip chỉ được chứa đoạn cubic");
        };
        cubics.push((from, *control_1, *control_2, *to));
        from = *to;
    }

    for index in 0..cubics.len() {
        let (_, _, control_2, join) = cubics[index];
        let (next_from, next_control_1, _, _) = cubics[(index + 1) % cubics.len()];
        assert_eq!(join, next_from);
        let outgoing = FitPoint {
            x: join.x - control_2.x,
            y: join.y - control_2.y,
        };
        let incoming = FitPoint {
            x: next_control_1.x - next_from.x,
            y: next_control_1.y - next_from.y,
        };
        let cross = outgoing.x * incoming.y - outgoing.y * incoming.x;
        let scale = outgoing.length() * incoming.length();
        assert!(cross.abs() <= scale * 1e-10);
        assert!(outgoing.dot(incoming) > 0.0);
    }
}

#[test]
fn straight_samples_collapse_to_one_line() {
    let points = (0..=20)
        .map(|x| FitPoint {
            x: f64::from(x),
            y: 3.0,
        })
        .collect::<Vec<_>>();
    let result = fit_open_with_tangents(
        &points,
        FitPoint { x: 1.0, y: 0.0 },
        FitPoint { x: 1.0, y: 0.0 },
        options(0.01),
    )
    .unwrap();

    assert_eq!(result.path.segments.len(), 1);
    assert!(matches!(result.path.segments[0], SceneSegment::Line { .. }));
    assert_eq!(result.output_nodes, 2);
    assert_eq!(result.max_error_px, 0.0);
}

#[test]
fn sampled_cubic_stays_within_requested_error() {
    let start = FitPoint { x: 0.0, y: 0.0 };
    let control_1 = FitPoint { x: 8.0, y: 0.0 };
    let control_2 = FitPoint { x: 12.0, y: 12.0 };
    let end = FitPoint { x: 20.0, y: 12.0 };
    let points = (0..=80)
        .map(|index| cubic_point(start, control_1, control_2, end, f64::from(index) / 80.0))
        .collect::<Vec<_>>();
    let requested = 0.03;
    let result = fit_open_with_tangents(
        &points,
        control_1.subtract(start),
        end.subtract(control_2),
        options(requested),
    )
    .unwrap();

    assert!(result
        .path
        .segments
        .iter()
        .any(|segment| matches!(segment, SceneSegment::Cubic { .. })));
    assert!(result.max_error_px <= requested);
    assert!(result.output_nodes < result.source_nodes / 4);
}

#[test]
fn square_corners_remain_hard_lines() {
    let ring = grid_ring(&[(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)]);
    let result = fit_closed_ring(&ring, options(0.2)).unwrap();

    assert_eq!(result.hard_corner_count, 4);
    assert_eq!(result.output_nodes, 4);
    assert!(result
        .path
        .segments
        .iter()
        .all(|segment| matches!(segment, SceneSegment::Line { .. })));
}

#[test]
fn circle_uses_cubics_and_reduces_nodes() {
    let mut samples = Vec::new();
    for index in 0..160 {
        let angle = std::f64::consts::TAU * index as f64 / 160.0;
        let point = (
            (60.0 + 50.0 * angle.cos()).round(),
            (60.0 + 50.0 * angle.sin()).round(),
        );
        if samples.last().copied() != Some(point) {
            samples.push(point);
        }
    }
    let ring = grid_ring(&samples);
    let result = fit_closed_ring(&ring, options(1.0)).unwrap();
    let cubic_count = result
        .path
        .segments
        .iter()
        .filter(|segment| matches!(segment, SceneSegment::Cubic { .. }))
        .count();

    assert_eq!(result.primitive, Some(ReconstructedPrimitive::Circle));
    assert_eq!(cubic_count, 4);
    assert_eq!(result.output_nodes, 4);
    assert!(result.max_error_px <= 1.0);
}

#[test]
fn rotated_ellipse_uses_four_cubics_without_lines() {
    let rotation = 0.37_f64;
    let mut samples = Vec::new();
    for index in 0..240 {
        let angle = std::f64::consts::TAU * index as f64 / 240.0;
        let local_x = 70.0 * angle.cos();
        let local_y = 32.0 * angle.sin();
        let point = (
            (100.0 + rotation.cos() * local_x - rotation.sin() * local_y).round(),
            (90.0 + rotation.sin() * local_x + rotation.cos() * local_y).round(),
        );
        if samples.last().copied() != Some(point) {
            samples.push(point);
        }
    }

    let result = fit_closed_ring(&grid_ring(&samples), options(1.0)).unwrap();

    assert_eq!(result.primitive, Some(ReconstructedPrimitive::Ellipse));
    assert_eq!(result.output_nodes, 4);
    assert!(result
        .path
        .segments
        .iter()
        .all(|segment| matches!(segment, SceneSegment::Cubic { .. })));
}

#[test]
fn large_circle_adapts_to_eight_cubics_and_preserves_winding() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-05): với bán kính lớn và sai số
    // chặt, bốn cung cubic không đủ ngân sách nhưng tám cung vẫn giảm node mạnh.
    let samples = (0..512)
        .map(|index| {
            let angle = -std::f64::consts::TAU * index as f64 / 512.0;
            (620.0 + 500.0 * angle.cos(), 610.0 + 500.0 * angle.sin())
        })
        .collect::<Vec<_>>();
    let ring = grid_ring(&samples);
    let result = fit_closed_ring(&ring, options(0.05)).unwrap();
    let repeated = fit_closed_ring(&ring, options(0.05)).unwrap();

    assert_eq!(result.primitive, Some(ReconstructedPrimitive::Circle));
    assert_eq!(result.output_nodes, 8);
    assert_eq!(result.path, repeated.path);
    assert!(result.max_error_px <= 0.05);
    assert!(endpoint_signed_area(&result.path) < 0.0);
    assert_closed_cubics_are_g1(&result.path);
}

#[test]
fn large_rotated_ellipse_adapts_to_eight_cubics() {
    let rotation = 0.41_f64;
    let samples = (0..768)
        .map(|index| {
            let angle = std::f64::consts::TAU * index as f64 / 768.0;
            let local_x = 600.0 * angle.cos();
            let local_y = 250.0 * angle.sin();
            (
                700.0 + rotation.cos() * local_x - rotation.sin() * local_y,
                400.0 + rotation.sin() * local_x + rotation.cos() * local_y,
            )
        })
        .collect::<Vec<_>>();
    let result = fit_closed_ring(&grid_ring(&samples), options(0.06)).unwrap();

    assert_eq!(result.primitive, Some(ReconstructedPrimitive::Ellipse));
    assert_eq!(result.output_nodes, 8);
    assert!(result.max_error_px <= 0.06);
    assert!(result
        .path
        .segments
        .iter()
        .all(|segment| matches!(segment, SceneSegment::Cubic { .. })));
    assert!(endpoint_signed_area(&result.path) > 0.0);
    assert_closed_cubics_are_g1(&result.path);
}

#[test]
fn superellipse_with_flat_shoulders_is_not_forced_to_ellipse() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-05): một blob gần tròn nhưng có
    // vai phẳng là ca âm, tránh nắn logo có chủ ý thành elip giả.
    let mut samples = Vec::new();
    for index in 0..240 {
        let angle = std::f64::consts::TAU * index as f64 / 240.0;
        let cosine = angle.cos();
        let sine = angle.sin();
        let point = (
            (80.0 + 50.0 * cosine.signum() * cosine.abs().sqrt()).round(),
            (80.0 + 50.0 * sine.signum() * sine.abs().sqrt()).round(),
        );
        if samples.last().copied() != Some(point) {
            samples.push(point);
        }
    }

    let result = fit_closed_ring(&grid_ring(&samples), options(1.0)).unwrap();

    assert_eq!(result.primitive, None);
    assert!(result.output_nodes > 4);
}

#[test]
fn recursive_cubics_keep_tangent_direction_at_joins() {
    let points = (0..=120)
        .map(|index| {
            let x = index as f64 / 4.0;
            FitPoint {
                x,
                y: 4.0 * (x / 3.5).sin(),
            }
        })
        .collect::<Vec<_>>();
    let derivative = |x: f64| FitPoint {
        x: 1.0,
        y: (4.0 / 3.5) * (x / 3.5).cos(),
    };
    let result = fit_open_with_tangents(
        &points,
        derivative(points[0].x),
        derivative(points[points.len() - 1].x),
        options(0.025),
    )
    .unwrap();

    let mut cubic_joins = 0;
    for pair in result.path.segments.windows(2) {
        let SceneSegment::Cubic { control_2, to, .. } = pair[0] else {
            continue;
        };
        let SceneSegment::Cubic { control_1, .. } = pair[1] else {
            continue;
        };
        let incoming = vector(control_2, to);
        let outgoing = vector(to, control_1);
        let cross = incoming.0 * outgoing.1 - incoming.1 * outgoing.0;
        let dot = incoming.0 * outgoing.0 + incoming.1 * outgoing.1;
        assert!(cross.abs() <= 1e-8 * length(incoming) * length(outgoing));
        assert!(dot > 0.0);
        cubic_joins += 1;
    }

    assert!(cubic_joins >= 1);
    assert!(result.max_error_px <= 0.025);
}

#[test]
fn trajectory_completion_refits_convex_ripple_with_fewer_segments() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-03): contour lượn nhẹ từ raster
    // không được biến mỗi tọa độ nửa pixel thành một khúc gãy.
    let samples = (0..192)
        .map(|index| {
            let angle = std::f64::consts::TAU * index as f64 / 192.0;
            let ripple = 0.72 * (3.0 * angle).cos();
            let radius = 48.0 + ripple;
            let x = ((80.0 + radius * angle.cos()) * 2.0).round() * 0.5;
            let y = ((76.0 + 0.82 * radius * angle.sin()) * 2.0).round() * 0.5;
            (x, y)
        })
        .fold(Vec::<(f64, f64)>::new(), |mut points, point| {
            if points.last().copied() != Some(point) {
                points.push(point);
            }
            points
        });
    let ring = grid_ring(&samples);
    let tolerance = 0.8;
    let balanced = fit_closed_ring(&ring, options(tolerance)).unwrap();
    let trajectory = fit_closed_ring(&ring, trajectory_options(tolerance)).unwrap();
    let balanced_lines = balanced
        .path
        .segments
        .iter()
        .filter(|segment| matches!(segment, SceneSegment::Line { .. }))
        .count();
    let trajectory_lines = trajectory
        .path
        .segments
        .iter()
        .filter(|segment| matches!(segment, SceneSegment::Line { .. }))
        .count();

    assert_eq!(balanced.primitive, None);
    assert_eq!(trajectory.primitive, None);
    assert!(trajectory.path.segments.len() < balanced.path.segments.len());
    assert!(trajectory_lines < balanced_lines);
    assert!(trajectory.max_error_px <= tolerance);
}

#[test]
fn half_pixel_saddle_vertices_are_protected_as_corners() {
    let ring = GridRing {
        label_index: 0,
        vertices: vec![
            GridPoint { x2: 0, y2: 0 },
            GridPoint {
                x2: 4 * CONTOUR_COORDINATE_SCALE,
                y2: 0,
            },
            GridPoint {
                x2: 4 * CONTOUR_COORDINATE_SCALE,
                y2: 3 * CONTOUR_COORDINATE_SCALE / 2,
            },
            GridPoint {
                x2: 7 * CONTOUR_COORDINATE_SCALE / 2,
                y2: 2 * CONTOUR_COORDINATE_SCALE,
            },
            GridPoint {
                x2: 4 * CONTOUR_COORDINATE_SCALE,
                y2: 5 * CONTOUR_COORDINATE_SCALE / 2,
            },
            GridPoint {
                x2: 4 * CONTOUR_COORDINATE_SCALE,
                y2: 4 * CONTOUR_COORDINATE_SCALE,
            },
            GridPoint {
                x2: 0,
                y2: 4 * CONTOUR_COORDINATE_SCALE,
            },
        ],
        saddle_cuts: 1,
    };
    let result = fit_closed_ring(&ring, options(0.4)).unwrap();

    assert!(result.hard_corner_count >= 2);
    assert!(result.path.segments.iter().any(|segment| {
        let point = segment.end_point();
        (point.x.fract().abs() - 0.5).abs() < 1e-9 || (point.y.fract().abs() - 0.5).abs() < 1e-9
    }));
}

fn vector(from: ScenePoint, to: ScenePoint) -> (f64, f64) {
    (to.x - from.x, to.y - from.y)
}

fn length(vector: (f64, f64)) -> f64 {
    vector.0.hypot(vector.1)
}
