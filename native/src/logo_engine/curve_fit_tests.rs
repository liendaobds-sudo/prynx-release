use super::contour::{GridPoint, GridRing, CONTOUR_COORDINATE_SCALE};
use super::curve_fit::{fit_closed_ring, fit_open_with_tangents, CurveFitOptions};
use super::scene::{ScenePoint, SceneSegment};
use super::simplify::FitPoint;

fn options(tolerance_px: f64) -> CurveFitOptions {
    CurveFitOptions {
        tolerance_px,
        corner_angle_degrees: 55.0,
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

    assert!(cubic_count >= 2);
    assert!(result.max_error_px <= 1.0);
    assert!(
        result.output_nodes < result.source_nodes / 3,
        "source={}, simplified={}, output={}, hard={}",
        result.source_nodes,
        result.simplified_nodes,
        result.output_nodes,
        result.hard_corner_count
    );
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
fn half_pixel_saddle_vertices_are_protected_as_corners() {
    let ring = GridRing {
        label_index: 0,
        vertices: vec![
            GridPoint { x2: 0, y2: 0 },
            GridPoint { x2: 8, y2: 0 },
            GridPoint { x2: 8, y2: 3 },
            GridPoint { x2: 7, y2: 4 },
            GridPoint { x2: 8, y2: 5 },
            GridPoint { x2: 8, y2: 8 },
            GridPoint { x2: 0, y2: 8 },
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
