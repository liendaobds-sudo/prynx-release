//! Nhận dạng primitive tròn/elip trước khi fallback sang fitter cubic tổng quát.

use super::{ReconstructedPrimitive, ScenePath, ScenePoint, SceneSegment};
use crate::logo_engine::simplify::{point_segment_distance, FitPoint};
use std::f64::consts::{PI, TAU};

const INITIAL_PRIMITIVE_SEGMENTS: usize = 4;

#[derive(Clone, Debug)]
pub(super) struct PrimitiveFit {
    pub(super) kind: ReconstructedPrimitive,
    pub(super) path: ScenePath,
    model: EllipseModel,
    signed_area: f64,
    segment_count: usize,
}

impl PrimitiveFit {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-05): tăng số cung theo cấp đôi
    // và không vượt số đỉnh nguồn; ứng viên đầu tiên đạt budget là tối giản.
    pub(super) fn refine_path(&mut self, max_segment_count: usize) -> bool {
        let Some(next_segment_count) = self.segment_count.checked_mul(2) else {
            return false;
        };
        if next_segment_count > max_segment_count {
            return false;
        }
        self.segment_count = next_segment_count;
        self.path = ellipse_to_cubics(self.model, self.signed_area, self.segment_count);
        true
    }
}

#[derive(Clone, Copy, Debug)]
struct EllipseModel {
    center: FitPoint,
    radius_x: f64,
    radius_y: f64,
    rotation: f64,
}

#[derive(Clone, Copy, Debug)]
struct PolygonMoments {
    signed_area: f64,
    center: FitPoint,
    variance_x: f64,
    variance_y: f64,
    covariance_xy: f64,
}

pub(super) fn fit_closed_primitive(points: &[FitPoint], tolerance: f64) -> Option<PrimitiveFit> {
    if points.len() < 12 || !tolerance.is_finite() || tolerance <= 0.0 {
        return None;
    }
    let moments = polygon_moments(points)?;
    let (major_radius, minor_radius, rotation) = ellipse_from_moments(moments)?;
    if minor_radius < (4.0 * tolerance).max(2.0) {
        return None;
    }

    let axis_ratio = major_radius / minor_radius;
    if axis_ratio <= 1.08 {
        if let Some(circle) = fit_circle(points, tolerance) {
            if primitive_passes(points, circle, moments.signed_area, tolerance) {
                return Some(PrimitiveFit {
                    kind: ReconstructedPrimitive::Circle,
                    path: ellipse_to_cubics(
                        circle,
                        moments.signed_area,
                        INITIAL_PRIMITIVE_SEGMENTS,
                    ),
                    model: circle,
                    signed_area: moments.signed_area,
                    segment_count: INITIAL_PRIMITIVE_SEGMENTS,
                });
            }
        }
    }

    let ellipse = EllipseModel {
        center: moments.center,
        radius_x: major_radius,
        radius_y: minor_radius,
        rotation,
    };
    primitive_passes(points, ellipse, moments.signed_area, tolerance).then(|| PrimitiveFit {
        kind: ReconstructedPrimitive::Ellipse,
        path: ellipse_to_cubics(ellipse, moments.signed_area, INITIAL_PRIMITIVE_SEGMENTS),
        model: ellipse,
        signed_area: moments.signed_area,
        segment_count: INITIAL_PRIMITIVE_SEGMENTS,
    })
}

fn fit_circle(points: &[FitPoint], tolerance: f64) -> Option<EllipseModel> {
    let mut normal = [[0.0; 3]; 3];
    let mut rhs = [0.0; 3];
    for index in 0..points.len() {
        let point = points[index];
        let previous = points[(index + points.len() - 1) % points.len()];
        let next = points[(index + 1) % points.len()];
        let weight = 0.5 * (point.distance(previous) + point.distance(next));
        let row = [point.x, point.y, 1.0];
        let target = -(point.x * point.x + point.y * point.y);
        for row_index in 0..3 {
            rhs[row_index] += weight * row[row_index] * target;
            for column in 0..3 {
                normal[row_index][column] += weight * row[row_index] * row[column];
            }
        }
    }
    let solution = solve_linear::<3>(normal, rhs)?;
    let mut center = FitPoint {
        x: -0.5 * solution[0],
        y: -0.5 * solution[1],
    };
    let radius_squared = center.x * center.x + center.y * center.y - solution[2];
    if radius_squared <= 0.0 || !radius_squared.is_finite() {
        return None;
    }
    let mut radius = radius_squared.sqrt();

    // LOGO-TRAJECTORY (audit 2026-08-25 F-05): refine theo khoảng cách
    // trực giao để mật độ đỉnh staircase không kéo lệch tâm primitive.
    for _ in 0..8 {
        let mut normal = [[0.0; 3]; 3];
        let mut rhs = [0.0; 3];
        for index in 0..points.len() {
            let point = points[index];
            let delta = center.subtract(point);
            let distance = delta.length();
            if distance <= 1e-12 {
                continue;
            }
            let residual = distance - radius;
            let previous = points[(index + points.len() - 1) % points.len()];
            let next = points[(index + 1) % points.len()];
            let edge_weight = 0.5 * (point.distance(previous) + point.distance(next));
            let huber_scale = tolerance.max(0.25);
            let robust = if residual.abs() <= huber_scale {
                1.0
            } else {
                huber_scale / residual.abs()
            };
            let weight = edge_weight * robust;
            let jacobian = [delta.x / distance, delta.y / distance, -1.0];
            for row in 0..3 {
                rhs[row] -= weight * jacobian[row] * residual;
                for column in 0..3 {
                    normal[row][column] += weight * jacobian[row] * jacobian[column];
                }
            }
        }
        let Some(step) = solve_linear::<3>(normal, rhs) else {
            break;
        };
        center.x += step[0];
        center.y += step[1];
        radius += step[2];
        if !center.is_finite() || !radius.is_finite() || radius <= 0.0 {
            return None;
        }
        if step[0].hypot(step[1]).max(step[2].abs()) <= 1e-8 {
            break;
        }
    }

    Some(EllipseModel {
        center,
        radius_x: radius,
        radius_y: radius,
        rotation: 0.0,
    })
}

fn polygon_moments(points: &[FitPoint]) -> Option<PolygonMoments> {
    let mut area_twice = 0.0;
    let mut center_x_numerator = 0.0;
    let mut center_y_numerator = 0.0;
    let mut integral_x_squared = 0.0;
    let mut integral_y_squared = 0.0;
    let mut integral_xy = 0.0;

    for index in 0..points.len() {
        let first = points[index];
        let second = points[(index + 1) % points.len()];
        let cross = first.x * second.y - second.x * first.y;
        area_twice += cross;
        center_x_numerator += (first.x + second.x) * cross;
        center_y_numerator += (first.y + second.y) * cross;
        integral_x_squared +=
            (first.x * first.x + first.x * second.x + second.x * second.x) * cross;
        integral_y_squared +=
            (first.y * first.y + first.y * second.y + second.y * second.y) * cross;
        integral_xy += (2.0 * first.x * first.y
            + first.x * second.y
            + second.x * first.y
            + 2.0 * second.x * second.y)
            * cross;
    }

    if !area_twice.is_finite() || area_twice.abs() <= 1e-9 {
        return None;
    }
    let signed_area = area_twice * 0.5;
    let center = FitPoint {
        x: center_x_numerator / (3.0 * area_twice),
        y: center_y_numerator / (3.0 * area_twice),
    };
    let mean_x_squared = (integral_x_squared / 12.0) / signed_area;
    let mean_y_squared = (integral_y_squared / 12.0) / signed_area;
    let mean_xy = (integral_xy / 24.0) / signed_area;
    let variance_x = mean_x_squared - center.x * center.x;
    let variance_y = mean_y_squared - center.y * center.y;
    let covariance_xy = mean_xy - center.x * center.y;
    (center.is_finite()
        && variance_x.is_finite()
        && variance_y.is_finite()
        && covariance_xy.is_finite()
        && variance_x > 0.0
        && variance_y > 0.0)
        .then_some(PolygonMoments {
            signed_area,
            center,
            variance_x,
            variance_y,
            covariance_xy,
        })
}

fn ellipse_from_moments(moments: PolygonMoments) -> Option<(f64, f64, f64)> {
    let trace = moments.variance_x + moments.variance_y;
    let discriminant = (moments.variance_x - moments.variance_y).hypot(2.0 * moments.covariance_xy);
    let major_variance = 0.5 * (trace + discriminant);
    let minor_variance = 0.5 * (trace - discriminant);
    if minor_variance <= 0.0 || !major_variance.is_finite() {
        return None;
    }
    let major_radius = 2.0 * major_variance.sqrt();
    let minor_radius = 2.0 * minor_variance.sqrt();
    let rotation =
        0.5 * (2.0 * moments.covariance_xy).atan2(moments.variance_x - moments.variance_y);
    Some((major_radius, minor_radius, rotation))
}

fn primitive_passes(
    points: &[FitPoint],
    ellipse: EllipseModel,
    signed_area: f64,
    tolerance: f64,
) -> bool {
    if !ellipse.center.is_finite()
        || !ellipse.radius_x.is_finite()
        || !ellipse.radius_y.is_finite()
        || ellipse.radius_x <= 0.0
        || ellipse.radius_y <= 0.0
        || ellipse.radius_x / ellipse.radius_y > 20.0
    {
        return false;
    }

    let mut max_error = 0.0_f64;
    let mut weighted_error_squared = 0.0;
    let mut total_weight = 0.0;
    for index in 0..points.len() {
        let point = points[index];
        let error = point_to_ellipse_distance(point, ellipse);
        if !error.is_finite() {
            return false;
        }
        max_error = max_error.max(error);
        let previous = points[(index + points.len() - 1) % points.len()];
        let next = points[(index + 1) % points.len()];
        let weight = 0.5 * (point.distance(previous) + point.distance(next));
        weighted_error_squared += weight * error * error;
        total_weight += weight;
    }
    let rms_error = (weighted_error_squared / total_weight.max(1e-12)).sqrt();
    if max_error > tolerance * 0.98 || rms_error > tolerance * 0.65 {
        return false;
    }

    let perimeter = ellipse_perimeter(ellipse);
    let reverse_error = ellipse_to_polyline_error(points, ellipse, perimeter, tolerance);
    let model_area = PI * ellipse.radius_x * ellipse.radius_y;
    let area_budget = perimeter * tolerance + PI * tolerance * tolerance;
    reverse_error <= tolerance * 0.98 && (signed_area.abs() - model_area).abs() <= area_budget
}

fn ellipse_to_polyline_error(
    points: &[FitPoint],
    ellipse: EllipseModel,
    perimeter: f64,
    tolerance: f64,
) -> f64 {
    let spacing = (tolerance * 0.5).max(0.5);
    let samples = (perimeter / spacing).ceil().max(64.0) as usize;
    (0..samples)
        .map(|index| {
            let angle = TAU * index as f64 / samples as f64;
            let point = ellipse_point(ellipse, angle);
            distance_to_closed_polyline(point, points)
        })
        .fold(0.0_f64, f64::max)
}

fn point_to_ellipse_distance(point: FitPoint, ellipse: EllipseModel) -> f64 {
    let cosine = ellipse.rotation.cos();
    let sine = ellipse.rotation.sin();
    let delta = point.subtract(ellipse.center);
    let local_x = cosine * delta.x + sine * delta.y;
    let local_y = -sine * delta.x + cosine * delta.y;
    let mut parameter = (ellipse.radius_x * local_y).atan2(ellipse.radius_y * local_x);

    for _ in 0..10 {
        let sin_parameter = parameter.sin();
        let cos_parameter = parameter.cos();
        let function = (ellipse.radius_y * ellipse.radius_y - ellipse.radius_x * ellipse.radius_x)
            * sin_parameter
            * cos_parameter
            + ellipse.radius_x * local_x * sin_parameter
            - ellipse.radius_y * local_y * cos_parameter;
        let derivative = (ellipse.radius_y * ellipse.radius_y
            - ellipse.radius_x * ellipse.radius_x)
            * (cos_parameter * cos_parameter - sin_parameter * sin_parameter)
            + ellipse.radius_x * local_x * cos_parameter
            + ellipse.radius_y * local_y * sin_parameter;
        if derivative.abs() <= 1e-12 || !derivative.is_finite() {
            break;
        }
        let step = function / derivative;
        parameter -= step;
        if step.abs() <= 1e-12 {
            break;
        }
    }
    (local_x - ellipse.radius_x * parameter.cos())
        .hypot(local_y - ellipse.radius_y * parameter.sin())
}

fn ellipse_to_cubics(ellipse: EllipseModel, signed_area: f64, segment_count: usize) -> ScenePath {
    let direction = if signed_area >= 0.0 { 1.0 } else { -1.0 };
    let delta = direction * TAU / segment_count as f64;
    let handle = (4.0 / 3.0) * (delta / 4.0).tan();
    let start = ellipse_point(ellipse, 0.0);
    let mut segments = Vec::with_capacity(segment_count);

    for index in 0..segment_count {
        let start_angle = delta * index as f64;
        let end_angle = delta * (index + 1) as f64;
        let from = if index == 0 {
            start
        } else {
            ellipse_point(ellipse, start_angle)
        };
        let to = if index + 1 == segment_count {
            start
        } else {
            ellipse_point(ellipse, end_angle)
        };
        let start_derivative = ellipse_derivative(ellipse, start_angle);
        let end_derivative = ellipse_derivative(ellipse, end_angle);
        segments.push(SceneSegment::Cubic {
            control_1: to_scene_point(from.add(start_derivative.scale(handle))),
            control_2: to_scene_point(to.subtract(end_derivative.scale(handle))),
            to: to_scene_point(to),
        });
    }

    ScenePath {
        start: to_scene_point(start),
        segments,
        closed: true,
    }
}

fn ellipse_point(ellipse: EllipseModel, parameter: f64) -> FitPoint {
    let cosine = ellipse.rotation.cos();
    let sine = ellipse.rotation.sin();
    let local_x = ellipse.radius_x * parameter.cos();
    let local_y = ellipse.radius_y * parameter.sin();
    FitPoint {
        x: ellipse.center.x + cosine * local_x - sine * local_y,
        y: ellipse.center.y + sine * local_x + cosine * local_y,
    }
}

fn ellipse_derivative(ellipse: EllipseModel, parameter: f64) -> FitPoint {
    let cosine = ellipse.rotation.cos();
    let sine = ellipse.rotation.sin();
    let local_x = -ellipse.radius_x * parameter.sin();
    let local_y = ellipse.radius_y * parameter.cos();
    FitPoint {
        x: cosine * local_x - sine * local_y,
        y: sine * local_x + cosine * local_y,
    }
}

fn ellipse_perimeter(ellipse: EllipseModel) -> f64 {
    let sum = ellipse.radius_x + ellipse.radius_y;
    let h = ((ellipse.radius_x - ellipse.radius_y) / sum).powi(2);
    PI * sum * (1.0 + 3.0 * h / (10.0 + (4.0 - 3.0 * h).sqrt()))
}

fn distance_to_closed_polyline(point: FitPoint, polyline: &[FitPoint]) -> f64 {
    (0..polyline.len())
        .map(|index| {
            point_segment_distance(
                point,
                polyline[index],
                polyline[(index + 1) % polyline.len()],
            )
        })
        .fold(f64::INFINITY, f64::min)
}

fn to_scene_point(point: FitPoint) -> ScenePoint {
    ScenePoint {
        x: point.x,
        y: point.y,
    }
}

fn solve_linear<const N: usize>(mut matrix: [[f64; N]; N], mut rhs: [f64; N]) -> Option<[f64; N]> {
    for pivot in 0..N {
        let row = (pivot..N).max_by(|first, second| {
            matrix[*first][pivot]
                .abs()
                .total_cmp(&matrix[*second][pivot].abs())
        })?;
        if matrix[row][pivot].abs() <= 1e-12 || !matrix[row][pivot].is_finite() {
            return None;
        }
        if row != pivot {
            matrix.swap(row, pivot);
            rhs.swap(row, pivot);
        }
        let divisor = matrix[pivot][pivot];
        for column in pivot..N {
            matrix[pivot][column] /= divisor;
        }
        rhs[pivot] /= divisor;
        for row in 0..N {
            if row == pivot {
                continue;
            }
            let factor = matrix[row][pivot];
            for column in pivot..N {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    rhs.iter().all(|value| value.is_finite()).then_some(rhs)
}
