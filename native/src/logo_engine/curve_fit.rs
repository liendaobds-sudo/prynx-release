//! Fit line/cubic theo sai số cho contour Logo Engine v2.

#![allow(dead_code)]

use super::contour::{GridRing, CONTOUR_COORDINATE_SCALE};
use super::scene::{ScenePath, ScenePoint, SceneSegment};
use super::simplify::{
    central_tangent, deterministic_anchor, farthest_index, point_segment_distance, simplify_closed,
    turn_angle_degrees_at_distance, FitPoint,
};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct CurveFitOptions {
    pub(super) tolerance_px: f64,
    pub(super) corner_angle_degrees: f64,
}

impl Default for CurveFitOptions {
    fn default() -> Self {
        Self {
            tolerance_px: 0.35,
            corner_angle_degrees: 55.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct CurveFitResult {
    pub(super) path: ScenePath,
    pub(super) source_nodes: usize,
    pub(super) simplified_nodes: usize,
    pub(super) output_nodes: usize,
    /// Cận trên bảo thủ từ mẫu contour nguồn tới chính ScenePath cuối.
    pub(super) max_error_px: f64,
    pub(super) hard_corner_count: usize,
}

#[derive(Clone, Copy, Debug)]
struct CubicBezier {
    start: FitPoint,
    control_1: FitPoint,
    control_2: FitPoint,
    end: FitPoint,
}

pub(super) fn fit_closed_ring(
    ring: &GridRing,
    options: CurveFitOptions,
) -> Result<CurveFitResult, String> {
    validate_options(options)?;
    if ring.vertices.len() < 3 {
        return Err("Curve-fit cần contour có ít nhất ba đỉnh".to_string());
    }
    let source = ring
        .vertices
        .iter()
        .map(|point| FitPoint {
            x: point.x2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
            y: point.y2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
        })
        .collect::<Vec<_>>();
    if source.iter().any(|point| !point.is_finite()) {
        return Err("Contour curve-fit chứa tọa độ không hữu hạn".to_string());
    }

    let protected = ring
        .vertices
        .iter()
        .enumerate()
        .filter_map(|(index, point)| {
            ((point.x2 % CONTOUR_COORDINATE_SCALE != 0)
                || (point.y2 % CONTOUR_COORDINATE_SCALE != 0))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    let simplify_tolerance = options.tolerance_px * 0.25;
    let fit_tolerance = options.tolerance_px - simplify_tolerance;
    let points = simplify_closed(&source, simplify_tolerance, &protected);

    let corner_probe_distance = (options.tolerance_px * 4.0).max(1.0);
    let hard_corners = (0..points.len())
        .filter(|index| {
            is_half_pixel(points[*index])
                || turn_angle_degrees_at_distance(&points, *index, corner_probe_distance)
                    >= options.corner_angle_degrees
        })
        .collect::<BTreeSet<_>>();
    let mut breaks = hard_corners.clone();
    if breaks.is_empty() {
        breaks.insert(deterministic_anchor(&points));
    }
    if breaks.len() == 1 {
        let anchor = *breaks.first().expect("đã có break curve-fit");
        breaks.insert(farthest_index(&points, anchor));
    }
    let breaks = breaks.into_iter().collect::<Vec<_>>();

    let mut segments = Vec::new();
    let mut max_fit_error = 0.0_f64;
    for position in 0..breaks.len() {
        let start_index = breaks[position];
        let end_index = breaks[(position + 1) % breaks.len()];
        let span = cyclic_span(&points, start_index, end_index);
        let start_tangent = if hard_corners.contains(&start_index) {
            span[1].subtract(span[0]).normalize()
        } else {
            central_tangent(&points, start_index)
        }
        .ok_or_else(|| "Không xác định được tiếp tuyến đầu curve-fit".to_string())?;
        let end_tangent = if hard_corners.contains(&end_index) {
            span[span.len() - 1]
                .subtract(span[span.len() - 2])
                .normalize()
        } else {
            central_tangent(&points, end_index)
        }
        .ok_or_else(|| "Không xác định được tiếp tuyến cuối curve-fit".to_string())?;
        fit_span(
            &span,
            start_tangent,
            end_tangent,
            fit_tolerance,
            &mut segments,
            &mut max_fit_error,
        )?;
    }

    let path = ScenePath {
        start: to_scene_point(points[breaks[0]]),
        segments,
        closed: true,
    };
    path.validate()?;
    debug_assert!(max_fit_error <= fit_tolerance + 1e-9);
    let boundary_error = path_boundary_error(&source, &path, options.tolerance_px * 0.001);
    if boundary_error > options.tolerance_px {
        return Err(format!(
            "Curve-fit vượt sai số cho phép: {boundary_error:.6} px > {:.6} px",
            options.tolerance_px
        ));
    }
    let output_nodes = path.node_count();
    Ok(CurveFitResult {
        path,
        source_nodes: source.len(),
        simplified_nodes: points.len(),
        output_nodes,
        max_error_px: boundary_error,
        hard_corner_count: hard_corners.len(),
    })
}

pub(super) fn fit_open_with_tangents(
    points: &[FitPoint],
    start_tangent: FitPoint,
    end_tangent: FitPoint,
    options: CurveFitOptions,
) -> Result<CurveFitResult, String> {
    validate_options(options)?;
    if points.len() < 2 || points.iter().any(|point| !point.is_finite()) {
        return Err("Đường mở curve-fit cần ít nhất hai điểm hữu hạn".to_string());
    }
    let start_tangent = start_tangent
        .normalize()
        .ok_or_else(|| "Tiếp tuyến đầu curve-fit không hợp lệ".to_string())?;
    let end_tangent = end_tangent
        .normalize()
        .ok_or_else(|| "Tiếp tuyến cuối curve-fit không hợp lệ".to_string())?;
    let mut segments = Vec::new();
    let mut max_error = 0.0;
    fit_span(
        points,
        start_tangent,
        end_tangent,
        options.tolerance_px,
        &mut segments,
        &mut max_error,
    )?;
    let path = ScenePath {
        start: to_scene_point(points[0]),
        segments,
        closed: false,
    };
    path.validate()?;
    debug_assert!(max_error <= options.tolerance_px + 1e-9);
    let boundary_error = path_boundary_error(points, &path, options.tolerance_px * 0.001);
    if boundary_error > options.tolerance_px {
        return Err(format!(
            "Curve-fit vượt sai số cho phép: {boundary_error:.6} px > {:.6} px",
            options.tolerance_px
        ));
    }
    let output_nodes = path.node_count();
    Ok(CurveFitResult {
        path,
        source_nodes: points.len(),
        simplified_nodes: points.len(),
        output_nodes,
        max_error_px: boundary_error,
        hard_corner_count: 0,
    })
}

fn fit_span(
    points: &[FitPoint],
    start_tangent: FitPoint,
    end_tangent: FitPoint,
    tolerance: f64,
    output: &mut Vec<SceneSegment>,
    max_output_error: &mut f64,
) -> Result<(), String> {
    if points.len() < 2 {
        return Err("Nhịp curve-fit không đủ điểm".to_string());
    }
    let line_error = points
        .iter()
        .map(|point| point_segment_distance(*point, points[0], points[points.len() - 1]))
        .fold(0.0_f64, f64::max);
    if points.len() == 2 || line_error <= tolerance {
        output.push(SceneSegment::Line {
            to: to_scene_point(points[points.len() - 1]),
        });
        *max_output_error = (*max_output_error).max(line_error);
        return Ok(());
    }

    let parameters = chord_length_parameters(points)?;
    let cubic = generate_cubic(points, &parameters, start_tangent, end_tangent);
    let (max_error, mut split) = maximum_cubic_error(points, &parameters, cubic);
    if max_error <= tolerance {
        output.push(SceneSegment::Cubic {
            control_1: to_scene_point(cubic.control_1),
            control_2: to_scene_point(cubic.control_2),
            to: to_scene_point(cubic.end),
        });
        *max_output_error = (*max_output_error).max(max_error);
        return Ok(());
    }

    if split == 0 || split + 1 >= points.len() {
        split = points.len() / 2;
    }
    let center_tangent = points[split + 1]
        .subtract(points[split - 1])
        .normalize()
        .ok_or_else(|| "Không xác định được tiếp tuyến tại điểm chia".to_string())?;
    fit_span(
        &points[..=split],
        start_tangent,
        center_tangent,
        tolerance,
        output,
        max_output_error,
    )?;
    fit_span(
        &points[split..],
        center_tangent,
        end_tangent,
        tolerance,
        output,
        max_output_error,
    )
}

fn generate_cubic(
    points: &[FitPoint],
    parameters: &[f64],
    start_tangent: FitPoint,
    end_tangent: FitPoint,
) -> CubicBezier {
    let start = points[0];
    let end = points[points.len() - 1];
    let mut c00 = 0.0;
    let mut c01 = 0.0;
    let mut c11 = 0.0;
    let mut x0 = 0.0;
    let mut x1 = 0.0;

    for (point, &parameter) in points.iter().zip(parameters) {
        let (b0, b1, b2, b3) = bernstein(parameter);
        let a1 = start_tangent.scale(b1);
        let a2 = end_tangent.scale(-b2);
        let base = start.scale(b0 + b1).add(end.scale(b2 + b3));
        let residual = point.subtract(base);
        c00 += a1.dot(a1);
        c01 += a1.dot(a2);
        c11 += a2.dot(a2);
        x0 += a1.dot(residual);
        x1 += a2.dot(residual);
    }

    let determinant = c00 * c11 - c01 * c01;
    let chord = start.distance(end);
    let source_length = points
        .windows(2)
        .map(|pair| pair[0].distance(pair[1]))
        .sum::<f64>();
    let fallback = chord / 3.0;
    let (alpha_1, alpha_2) = if determinant.abs() > 1e-12 {
        (
            (x0 * c11 - x1 * c01) / determinant,
            (c00 * x1 - c01 * x0) / determinant,
        )
    } else {
        (fallback, fallback)
    };
    let alpha_1 = valid_handle(alpha_1, source_length).unwrap_or(fallback);
    let alpha_2 = valid_handle(alpha_2, source_length).unwrap_or(fallback);

    CubicBezier {
        start,
        control_1: start.add(start_tangent.scale(alpha_1)),
        control_2: end.subtract(end_tangent.scale(alpha_2)),
        end,
    }
}

fn valid_handle(value: f64, source_length: f64) -> Option<f64> {
    (value.is_finite() && value > 1e-9 && value <= source_length).then_some(value)
}

fn chord_length_parameters(points: &[FitPoint]) -> Result<Vec<f64>, String> {
    let mut parameters = Vec::with_capacity(points.len());
    parameters.push(0.0);
    for index in 1..points.len() {
        parameters.push(parameters[index - 1] + points[index].distance(points[index - 1]));
    }
    let total = *parameters.last().unwrap_or(&0.0);
    if total <= f64::EPSILON || !total.is_finite() {
        return Err("Nhịp curve-fit có tổng chiều dài bằng 0".to_string());
    }
    for parameter in &mut parameters {
        *parameter /= total;
    }
    Ok(parameters)
}

fn maximum_cubic_error(
    points: &[FitPoint],
    parameters: &[f64],
    cubic: CubicBezier,
) -> (f64, usize) {
    let mut max_error = 0.0;
    let mut split = points.len() / 2;
    for index in 1..points.len() - 1 {
        let error = evaluate_cubic(cubic, parameters[index]).distance(points[index]);
        if error > max_error {
            max_error = error;
            split = index;
        }
    }
    (max_error, split)
}

fn evaluate_cubic(cubic: CubicBezier, parameter: f64) -> FitPoint {
    let (b0, b1, b2, b3) = bernstein(parameter);
    cubic
        .start
        .scale(b0)
        .add(cubic.control_1.scale(b1))
        .add(cubic.control_2.scale(b2))
        .add(cubic.end.scale(b3))
}

fn bernstein(parameter: f64) -> (f64, f64, f64, f64) {
    let inverse = 1.0 - parameter;
    (
        inverse * inverse * inverse,
        3.0 * parameter * inverse * inverse,
        3.0 * parameter * parameter * inverse,
        parameter * parameter * parameter,
    )
}

fn cyclic_span(points: &[FitPoint], start: usize, end: usize) -> Vec<FitPoint> {
    let mut span = vec![points[start]];
    let mut current = start;
    while current != end {
        current = (current + 1) % points.len();
        span.push(points[current]);
    }
    span
}

fn is_half_pixel(point: FitPoint) -> bool {
    (point.x.fract().abs() - 0.5).abs() < 1e-9 || (point.y.fract().abs() - 0.5).abs() < 1e-9
}

fn to_scene_point(point: FitPoint) -> ScenePoint {
    ScenePoint {
        x: point.x,
        y: point.y,
    }
}

fn validate_options(options: CurveFitOptions) -> Result<(), String> {
    if !options.tolerance_px.is_finite() || options.tolerance_px <= 0.0 {
        return Err("Sai số curve-fit phải là số hữu hạn lớn hơn 0".to_string());
    }
    if !options.corner_angle_degrees.is_finite()
        || options.corner_angle_degrees <= 0.0
        || options.corner_angle_degrees >= 180.0
    {
        return Err("Ngưỡng góc curve-fit phải nằm trong khoảng 0–180 độ".to_string());
    }
    Ok(())
}

fn path_boundary_error(points: &[FitPoint], path: &ScenePath, precision: f64) -> f64 {
    let index = SegmentBvh::from_path(path);
    points
        .iter()
        .map(|point| index.distance_upper_bound(*point, precision.max(1e-9), f64::INFINITY))
        .fold(0.0_f64, f64::max)
}

#[derive(Clone, Copy, Debug)]
struct AxisAlignedBounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl AxisAlignedBounds {
    fn from_line(start: FitPoint, end: FitPoint) -> Self {
        Self {
            min_x: start.x.min(end.x),
            min_y: start.y.min(end.y),
            max_x: start.x.max(end.x),
            max_y: start.y.max(end.y),
        }
    }

    fn from_cubic(cubic: CubicBezier) -> Self {
        Self {
            min_x: cubic
                .start
                .x
                .min(cubic.control_1.x)
                .min(cubic.control_2.x)
                .min(cubic.end.x),
            min_y: cubic
                .start
                .y
                .min(cubic.control_1.y)
                .min(cubic.control_2.y)
                .min(cubic.end.y),
            max_x: cubic
                .start
                .x
                .max(cubic.control_1.x)
                .max(cubic.control_2.x)
                .max(cubic.end.x),
            max_y: cubic
                .start
                .y
                .max(cubic.control_1.y)
                .max(cubic.control_2.y)
                .max(cubic.end.y),
        }
    }

    fn union(self, other: Self) -> Self {
        Self {
            min_x: self.min_x.min(other.min_x),
            min_y: self.min_y.min(other.min_y),
            max_x: self.max_x.max(other.max_x),
            max_y: self.max_y.max(other.max_y),
        }
    }

    fn center_x(self) -> f64 {
        (self.min_x + self.max_x) * 0.5
    }

    fn center_y(self) -> f64 {
        (self.min_y + self.max_y) * 0.5
    }

    fn distance(self, point: FitPoint) -> f64 {
        let dx = if point.x < self.min_x {
            self.min_x - point.x
        } else if point.x > self.max_x {
            point.x - self.max_x
        } else {
            0.0
        };
        let dy = if point.y < self.min_y {
            self.min_y - point.y
        } else if point.y > self.max_y {
            point.y - self.max_y
        } else {
            0.0
        };
        dx.hypot(dy)
    }
}

#[derive(Clone, Copy, Debug)]
enum IndexedPathSegment {
    Line { start: FitPoint, end: FitPoint },
    Cubic(CubicBezier),
}

impl IndexedPathSegment {
    fn bounds(self) -> AxisAlignedBounds {
        match self {
            Self::Line { start, end } => AxisAlignedBounds::from_line(start, end),
            Self::Cubic(cubic) => AxisAlignedBounds::from_cubic(cubic),
        }
    }

    fn distance_upper_bound(self, point: FitPoint, precision: f64) -> f64 {
        match self {
            Self::Line { start, end } => point_segment_distance(point, start, end),
            Self::Cubic(cubic) => point_cubic_distance_upper_bound(point, cubic, precision),
        }
    }
}

#[derive(Debug)]
enum SegmentBvh {
    Leaf {
        bounds: AxisAlignedBounds,
        segments: Vec<IndexedPathSegment>,
    },
    Branch {
        bounds: AxisAlignedBounds,
        left: Box<SegmentBvh>,
        right: Box<SegmentBvh>,
    },
}

impl SegmentBvh {
    fn from_path(path: &ScenePath) -> Self {
        let mut segments = Vec::with_capacity(path.segments.len() + usize::from(path.closed));
        let mut current = from_scene_point(path.start);
        for segment in &path.segments {
            match segment {
                SceneSegment::Line { to } => {
                    let end = from_scene_point(*to);
                    segments.push(IndexedPathSegment::Line {
                        start: current,
                        end,
                    });
                    current = end;
                }
                SceneSegment::Cubic {
                    control_1,
                    control_2,
                    to,
                } => {
                    let cubic = CubicBezier {
                        start: current,
                        control_1: from_scene_point(*control_1),
                        control_2: from_scene_point(*control_2),
                        end: from_scene_point(*to),
                    };
                    segments.push(IndexedPathSegment::Cubic(cubic));
                    current = cubic.end;
                }
            }
        }
        let start = from_scene_point(path.start);
        if path.closed && current != start {
            segments.push(IndexedPathSegment::Line {
                start: current,
                end: start,
            });
        }
        debug_assert!(!segments.is_empty());
        Self::build(segments)
    }

    fn build(mut segments: Vec<IndexedPathSegment>) -> Self {
        let bounds = segments
            .iter()
            .map(|segment| segment.bounds())
            .reduce(AxisAlignedBounds::union)
            .expect("ScenePath hợp lệ luôn có segment");
        if segments.len() <= 8 {
            return Self::Leaf { bounds, segments };
        }
        let split_x = bounds.max_x - bounds.min_x >= bounds.max_y - bounds.min_y;
        segments.sort_by(|first, second| {
            let first = first.bounds();
            let second = second.bounds();
            if split_x {
                first.center_x().total_cmp(&second.center_x())
            } else {
                first.center_y().total_cmp(&second.center_y())
            }
        });
        let right_segments = segments.split_off(segments.len() / 2);
        let left = Box::new(Self::build(segments));
        let right = Box::new(Self::build(right_segments));
        Self::Branch {
            bounds,
            left,
            right,
        }
    }

    fn bounds(&self) -> AxisAlignedBounds {
        match self {
            Self::Leaf { bounds, .. } | Self::Branch { bounds, .. } => *bounds,
        }
    }

    fn distance_upper_bound(&self, point: FitPoint, precision: f64, mut best: f64) -> f64 {
        if self.bounds().distance(point) >= best {
            return best;
        }
        match self {
            Self::Leaf { segments, .. } => {
                for segment in segments {
                    if segment.bounds().distance(point) < best {
                        best = best.min(segment.distance_upper_bound(point, precision));
                    }
                }
                best
            }
            Self::Branch { left, right, .. } => {
                let left_distance = left.bounds().distance(point);
                let right_distance = right.bounds().distance(point);
                let (near, far, far_distance) = if left_distance <= right_distance {
                    (left, right, right_distance)
                } else {
                    (right, left, left_distance)
                };
                best = near.distance_upper_bound(point, precision, best);
                if far_distance < best {
                    best = far.distance_upper_bound(point, precision, best);
                }
                best
            }
        }
    }
}

fn point_cubic_distance_upper_bound(point: FitPoint, cubic: CubicBezier, precision: f64) -> f64 {
    let mut best = f64::INFINITY;
    let mut stack = vec![cubic];
    while let Some(candidate) = stack.pop() {
        if distance_to_bounding_box(point, candidate) >= best {
            continue;
        }
        let flatness = cubic_flatness(candidate);
        if flatness <= precision {
            best =
                best.min(point_segment_distance(point, candidate.start, candidate.end) + flatness);
            continue;
        }
        let (left, right) = split_cubic(candidate);
        stack.push(right);
        stack.push(left);
    }
    best
}

fn cubic_flatness(cubic: CubicBezier) -> f64 {
    point_segment_distance(cubic.control_1, cubic.start, cubic.end).max(point_segment_distance(
        cubic.control_2,
        cubic.start,
        cubic.end,
    ))
}

fn split_cubic(cubic: CubicBezier) -> (CubicBezier, CubicBezier) {
    let first = midpoint(cubic.start, cubic.control_1);
    let second = midpoint(cubic.control_1, cubic.control_2);
    let third = midpoint(cubic.control_2, cubic.end);
    let fourth = midpoint(first, second);
    let fifth = midpoint(second, third);
    let center = midpoint(fourth, fifth);
    (
        CubicBezier {
            start: cubic.start,
            control_1: first,
            control_2: fourth,
            end: center,
        },
        CubicBezier {
            start: center,
            control_1: fifth,
            control_2: third,
            end: cubic.end,
        },
    )
}

fn midpoint(first: FitPoint, second: FitPoint) -> FitPoint {
    first.add(second).scale(0.5)
}

fn distance_to_bounding_box(point: FitPoint, cubic: CubicBezier) -> f64 {
    AxisAlignedBounds::from_cubic(cubic).distance(point)
}

fn from_scene_point(point: ScenePoint) -> FitPoint {
    FitPoint {
        x: point.x,
        y: point.y,
    }
}
