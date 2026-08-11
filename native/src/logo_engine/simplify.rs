//! Primitive hình học và simplify theo sai số cho Logo Engine v2.

#![allow(dead_code)]

use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct FitPoint {
    pub(super) x: f64,
    pub(super) y: f64,
}

impl FitPoint {
    pub(super) fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
        }
    }

    pub(super) fn subtract(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }

    pub(super) fn scale(self, factor: f64) -> Self {
        Self {
            x: self.x * factor,
            y: self.y * factor,
        }
    }

    pub(super) fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y
    }

    pub(super) fn length(self) -> f64 {
        self.x.hypot(self.y)
    }

    pub(super) fn distance(self, other: Self) -> f64 {
        self.subtract(other).length()
    }

    pub(super) fn normalize(self) -> Option<Self> {
        let length = self.length();
        (length > f64::EPSILON && length.is_finite()).then(|| self.scale(1.0 / length))
    }

    pub(super) fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

pub(super) fn simplify_closed(
    points: &[FitPoint],
    tolerance: f64,
    protected_indices: &[usize],
) -> Vec<FitPoint> {
    if points.len() < 4 || tolerance <= 0.0 {
        return points.to_vec();
    }

    let mut breaks = protected_indices
        .iter()
        .copied()
        .filter(|index| *index < points.len())
        .collect::<BTreeSet<_>>();
    if breaks.is_empty() {
        breaks.insert(deterministic_anchor(points));
    }
    if breaks.len() == 1 {
        let anchor = *breaks.first().expect("đã có anchor simplify");
        breaks.insert(farthest_index(points, anchor));
    }
    let breaks = breaks.into_iter().collect::<Vec<_>>();

    let mut simplified = Vec::new();
    for position in 0..breaks.len() {
        let start = breaks[position];
        let end = breaks[(position + 1) % breaks.len()];
        let arc = cyclic_arc(points, start, end);
        let arc = simplify_open(&arc, tolerance);
        if simplified.is_empty() {
            simplified.extend(arc);
        } else {
            simplified.extend(arc.into_iter().skip(1));
        }
    }
    if simplified.last() == simplified.first() {
        simplified.pop();
    }
    if simplified.len() < 3 {
        points.to_vec()
    } else {
        simplified
    }
}

pub(super) fn simplify_open(points: &[FitPoint], tolerance: f64) -> Vec<FitPoint> {
    if points.len() <= 2 || tolerance <= 0.0 {
        return points.to_vec();
    }

    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0_usize, points.len() - 1)];
    while let Some((start, end)) = stack.pop() {
        if end <= start + 1 {
            continue;
        }
        let mut farthest = None;
        let mut max_distance = 0.0_f64;
        for index in start + 1..end {
            let distance = point_segment_distance(points[index], points[start], points[end]);
            if distance > max_distance {
                max_distance = distance;
                farthest = Some(index);
            }
        }
        if max_distance > tolerance {
            let split = farthest.expect("đã có điểm giữa khi vượt tolerance");
            keep[split] = true;
            stack.push((split, end));
            stack.push((start, split));
        }
    }

    points
        .iter()
        .copied()
        .zip(keep)
        .filter_map(|(point, keep)| keep.then_some(point))
        .collect()
}

pub(super) fn point_segment_distance(point: FitPoint, start: FitPoint, end: FitPoint) -> f64 {
    let segment = end.subtract(start);
    let length_squared = segment.dot(segment);
    if length_squared <= f64::EPSILON {
        return point.distance(start);
    }
    let projection = point.subtract(start).dot(segment) / length_squared;
    let projection = projection.clamp(0.0, 1.0);
    point.distance(start.add(segment.scale(projection)))
}

pub(super) fn turn_angle_degrees(points: &[FitPoint], index: usize) -> f64 {
    let count = points.len();
    let incoming = points[index]
        .subtract(points[(index + count - 1) % count])
        .normalize();
    let outgoing = points[(index + 1) % count]
        .subtract(points[index])
        .normalize();
    match (incoming, outgoing) {
        (Some(incoming), Some(outgoing)) => {
            incoming.dot(outgoing).clamp(-1.0, 1.0).acos().to_degrees()
        }
        _ => 180.0,
    }
}

pub(super) fn turn_angle_degrees_at_distance(
    points: &[FitPoint],
    index: usize,
    probe_distance: f64,
) -> f64 {
    if points.len() < 3 {
        return 180.0;
    }
    let previous = probe_neighbor(points, index, probe_distance, false);
    let next = probe_neighbor(points, index, probe_distance, true);
    let incoming = points[index].subtract(points[previous]).normalize();
    let outgoing = points[next].subtract(points[index]).normalize();
    match (incoming, outgoing) {
        (Some(incoming), Some(outgoing)) => {
            incoming.dot(outgoing).clamp(-1.0, 1.0).acos().to_degrees()
        }
        _ => 180.0,
    }
}

pub(super) fn central_tangent(points: &[FitPoint], index: usize) -> Option<FitPoint> {
    let count = points.len();
    points[(index + 1) % count]
        .subtract(points[(index + count - 1) % count])
        .normalize()
}

pub(super) fn deterministic_anchor(points: &[FitPoint]) -> usize {
    points
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            left.y
                .total_cmp(&right.y)
                .then_with(|| left.x.total_cmp(&right.x))
        })
        .map(|(index, _)| index)
        .unwrap_or(0)
}

pub(super) fn farthest_index(points: &[FitPoint], anchor: usize) -> usize {
    points
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != anchor)
        .max_by(|(_, left), (_, right)| {
            left.distance(points[anchor])
                .total_cmp(&right.distance(points[anchor]))
        })
        .map(|(index, _)| index)
        .unwrap_or(anchor)
}

fn cyclic_arc(points: &[FitPoint], start: usize, end: usize) -> Vec<FitPoint> {
    let mut arc = vec![points[start]];
    let mut current = start;
    while current != end {
        current = (current + 1) % points.len();
        arc.push(points[current]);
    }
    arc
}

fn probe_neighbor(points: &[FitPoint], index: usize, probe_distance: f64, forward: bool) -> usize {
    let mut current = index;
    let mut distance = 0.0;
    for _ in 0..points.len() - 1 {
        let next = if forward {
            (current + 1) % points.len()
        } else {
            (current + points.len() - 1) % points.len()
        };
        distance += points[current].distance(points[next]);
        current = next;
        if distance >= probe_distance {
            break;
        }
    }
    current
}
