//! Phân loại outer/hole và kiểm tra topology contour cho Logo Engine v2.

#![allow(dead_code)]

use super::contour::{extract_contours, GridPoint, GridRing, CONTOUR_COORDINATE_SCALE};
use super::scene::{
    FillRing, PreprocessArtifact, RingRole, SceneGeometry, ScenePath, ScenePoint, SceneSegment,
    VectorLayer, Winding,
};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ClassifiedRing {
    pub(super) label_index: u16,
    pub(super) vertices: Vec<GridPoint>,
    pub(super) role: RingRole,
    pub(super) winding: Winding,
    pub(super) parent_ring: Option<usize>,
    pub(super) nesting_depth: usize,
    pub(super) signed_area_twice: i128,
    pub(super) saddle_cuts: u64,
}

pub(super) fn build_vector_layers(
    artifact: &PreprocessArtifact,
) -> Result<Vec<VectorLayer>, String> {
    let contours = extract_contours(artifact)?;
    let classified = classify_contours(&contours)?;
    let mut layers = Vec::new();

    for label_index in 0..artifact.palette.len() {
        if artifact.label_pixel_counts[label_index] == 0 {
            continue;
        }
        let label = label_index as u16;
        let label_rings = classified
            .iter()
            .filter(|ring| ring.label_index == label)
            .collect::<Vec<_>>();
        if label_rings.is_empty() {
            return Err("Nhãn màu có pixel nhưng không sinh được contour".to_string());
        }

        // LOGO-ENGINE-V2 (audit 2026-08-11 Lô C): tổng diện tích có dấu phải
        // bằng đúng số pixel của nhãn; lỗ và island không được làm trôi topology.
        let signed_area_twice = label_rings
            .iter()
            .map(|ring| ring.signed_area_twice)
            .sum::<i128>();
        let saddle_cuts = label_rings
            .iter()
            .map(|ring| i128::from(ring.saddle_cuts))
            .sum::<i128>();
        let scale_squared = i128::from(CONTOUR_COORDINATE_SCALE).pow(2);
        let saddle_area_twice = saddle_cuts * scale_squared / 4;
        let expected_area_twice =
            i128::from(artifact.label_pixel_counts[label_index]) * 2 * scale_squared;
        if signed_area_twice + saddle_area_twice != expected_area_twice {
            return Err(format!(
                "Diện tích contour nhãn {label_index} không khớp raster sau bù saddle: {signed_area_twice} + {saddle_cuts} so với {expected_area_twice}"
            ));
        }

        let rings = label_rings
            .into_iter()
            .map(|ring| FillRing {
                role: ring.role,
                winding: ring.winding,
                path: ring_to_scene_path(&ring.vertices),
            })
            .collect();
        layers.push(VectorLayer {
            paint: artifact.palette[label_index],
            geometry: vec![SceneGeometry::FillRegion { rings }],
        });
    }

    Ok(layers)
}

pub(super) fn classify_contours(contours: &[GridRing]) -> Result<Vec<ClassifiedRing>, String> {
    let mut signed_areas = Vec::with_capacity(contours.len());
    for contour in contours {
        validate_simple_ring(&contour.vertices)?;
        let area = signed_area_twice(&contour.vertices);
        if area == 0 {
            return Err("Contour có diện tích bằng 0".to_string());
        }
        signed_areas.push(area);
    }

    let mut parents = vec![None; contours.len()];
    for (index, contour) in contours.iter().enumerate() {
        let sample = interior_sample(&contour.vertices, signed_areas[index]);
        let own_area = signed_areas[index].abs();
        let mut best_parent = None;
        let mut best_area = i128::MAX;

        for (candidate_index, candidate) in contours.iter().enumerate() {
            if candidate_index == index || candidate.label_index != contour.label_index {
                continue;
            }
            let candidate_area = signed_areas[candidate_index].abs();
            if candidate_area <= own_area || candidate_area >= best_area {
                continue;
            }
            if point_in_polygon(sample, &candidate.vertices) {
                best_parent = Some(candidate_index);
                best_area = candidate_area;
            }
        }
        parents[index] = best_parent;
    }

    let mut classified = Vec::with_capacity(contours.len());
    for (index, contour) in contours.iter().enumerate() {
        let nesting_depth = nesting_depth(index, &parents)?;
        let role = if nesting_depth % 2 == 0 {
            RingRole::Outer
        } else {
            RingRole::Hole
        };
        let winding = if signed_areas[index] > 0 {
            Winding::Clockwise
        } else {
            Winding::CounterClockwise
        };
        let winding_matches_role = matches!(
            (role, winding),
            (RingRole::Outer, Winding::Clockwise) | (RingRole::Hole, Winding::CounterClockwise)
        );
        if !winding_matches_role {
            return Err("Chiều contour không khớp cây outer/hole".to_string());
        }
        classified.push(ClassifiedRing {
            label_index: contour.label_index,
            vertices: contour.vertices.clone(),
            role,
            winding,
            parent_ring: parents[index],
            nesting_depth,
            signed_area_twice: signed_areas[index],
            saddle_cuts: contour.saddle_cuts,
        });
    }
    Ok(classified)
}

fn nesting_depth(index: usize, parents: &[Option<usize>]) -> Result<usize, String> {
    let mut depth = 0;
    let mut current = parents[index];
    while let Some(parent) = current {
        depth += 1;
        if depth > parents.len() {
            return Err("Cây outer/hole chứa chu trình".to_string());
        }
        current = parents[parent];
    }
    Ok(depth)
}

fn ring_to_scene_path(vertices: &[GridPoint]) -> ScenePath {
    ScenePath {
        start: to_scene_point(vertices[0]),
        segments: vertices
            .iter()
            .skip(1)
            .map(|point| SceneSegment::Line {
                to: to_scene_point(*point),
            })
            .collect(),
        closed: true,
    }
}

fn to_scene_point(point: GridPoint) -> ScenePoint {
    ScenePoint {
        x: point.x2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
        y: point.y2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
    }
}

pub(super) fn validate_simple_ring(vertices: &[GridPoint]) -> Result<(), String> {
    if vertices.len() < 3 {
        return Err("Contour cần ít nhất ba đỉnh".to_string());
    }
    let mut seen_vertices = HashSet::with_capacity(vertices.len());
    for index in 0..vertices.len() {
        if vertices[index] == vertices[(index + 1) % vertices.len()] {
            return Err("Contour chứa cạnh dài bằng 0".to_string());
        }
        if !seen_vertices.insert((vertices[index].x2, vertices[index].y2)) {
            return Err("Contour tự cắt hoặc tự chạm".to_string());
        }
    }

    let count = vertices.len();
    let mut buckets = HashMap::<(i64, i64), Vec<usize>>::new();
    let mut checked_pairs = HashSet::<(usize, usize)>::new();
    for segment in 0..count {
        let next = (segment + 1) % count;
        let start = vertices[segment];
        let end = vertices[next];
        for bucket_x in start.x2.min(end.x2)..=start.x2.max(end.x2) {
            for bucket_y in start.y2.min(end.y2)..=start.y2.max(end.y2) {
                let entries = buckets.entry((bucket_x, bucket_y)).or_default();
                for &other in entries.iter() {
                    let other_next = (other + 1) % count;
                    if next == other || other_next == segment {
                        continue;
                    }
                    let pair = (other.min(segment), other.max(segment));
                    if checked_pairs.insert(pair)
                        && segments_intersect(start, end, vertices[other], vertices[other_next])
                    {
                        return Err("Contour tự cắt hoặc tự chạm".to_string());
                    }
                }
                entries.push(segment);
            }
        }
    }
    Ok(())
}

fn segments_intersect(a: GridPoint, b: GridPoint, c: GridPoint, d: GridPoint) -> bool {
    let o1 = orientation(a, b, c);
    let o2 = orientation(a, b, d);
    let o3 = orientation(c, d, a);
    let o4 = orientation(c, d, b);

    if o1 == 0 && on_segment(a, b, c) {
        return true;
    }
    if o2 == 0 && on_segment(a, b, d) {
        return true;
    }
    if o3 == 0 && on_segment(c, d, a) {
        return true;
    }
    if o4 == 0 && on_segment(c, d, b) {
        return true;
    }
    (o1 > 0) != (o2 > 0) && (o3 > 0) != (o4 > 0)
}

fn orientation(a: GridPoint, b: GridPoint, c: GridPoint) -> i128 {
    let ab_x = i128::from(b.x2) - i128::from(a.x2);
    let ab_y = i128::from(b.y2) - i128::from(a.y2);
    let ac_x = i128::from(c.x2) - i128::from(a.x2);
    let ac_y = i128::from(c.y2) - i128::from(a.y2);
    ab_x * ac_y - ab_y * ac_x
}

fn on_segment(a: GridPoint, b: GridPoint, point: GridPoint) -> bool {
    point.x2 >= a.x2.min(b.x2)
        && point.x2 <= a.x2.max(b.x2)
        && point.y2 >= a.y2.min(b.y2)
        && point.y2 <= a.y2.max(b.y2)
}

fn signed_area_twice(vertices: &[GridPoint]) -> i128 {
    (0..vertices.len())
        .map(|index| {
            let current = vertices[index];
            let next = vertices[(index + 1) % vertices.len()];
            i128::from(current.x2) * i128::from(next.y2)
                - i128::from(next.x2) * i128::from(current.y2)
        })
        .sum()
}

fn interior_sample(vertices: &[GridPoint], signed_area: i128) -> (f64, f64) {
    let start = vertices[0];
    let end = vertices[1];
    let dx = (end.x2 - start.x2) as f64;
    let dy = (end.y2 - start.y2) as f64;
    let length = dx.hypot(dy);
    let (normal_x, normal_y) = if signed_area > 0 {
        (-dy / length, dx / length)
    } else {
        (dy / length, -dx / length)
    };
    (
        (start.x2 + end.x2) as f64 / 2.0 + normal_x * 0.25,
        (start.y2 + end.y2) as f64 / 2.0 + normal_y * 0.25,
    )
}

fn point_in_polygon(point: (f64, f64), vertices: &[GridPoint]) -> bool {
    let mut inside = false;
    let (point_x, point_y) = point;
    for index in 0..vertices.len() {
        let first = vertices[index];
        let second = vertices[(index + 1) % vertices.len()];
        let first_x = first.x2 as f64;
        let first_y = first.y2 as f64;
        let second_x = second.x2 as f64;
        let second_y = second.y2 as f64;
        if (first_y > point_y) != (second_y > point_y) {
            let crossing_x =
                (second_x - first_x) * (point_y - first_y) / (second_y - first_y) + first_x;
            if point_x < crossing_x {
                inside = !inside;
            }
        }
    }
    inside
}
