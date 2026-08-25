//! Trích biên chính xác trên lưới pixel cho Logo Engine v2.

#![allow(dead_code)]

use super::scene::PreprocessArtifact;
use std::collections::HashMap;

pub(super) const CONTOUR_COORDINATE_SCALE: i64 = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct GridPoint {
    /// Tọa độ nhân 2; số lẻ biểu diễn vị trí half-pixel tại saddle.
    pub(super) x2: i64,
    pub(super) y2: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct GridRing {
    pub(super) label_index: u16,
    pub(super) vertices: Vec<GridPoint>,
    /// Mỗi corner saddle được vát nửa pixel và cắt một tam giác 1/8 px².
    pub(super) saddle_cuts: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct LatticePoint {
    x: u32,
    y: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Direction {
    East = 0,
    South = 1,
    West = 2,
    North = 3,
}

#[derive(Clone, Copy, Debug)]
struct BoundaryEdge {
    start: LatticePoint,
    end: LatticePoint,
    direction: Direction,
}

pub(super) fn extract_contours(artifact: &PreprocessArtifact) -> Result<Vec<GridRing>, String> {
    artifact.validate_contract()?;
    let width = artifact.width_px as usize;
    let height = artifact.height_px as usize;
    let edges_by_label =
        collect_boundary_edges(&artifact.labels, width, height, artifact.palette.len());
    let mut rings = Vec::new();

    for (label_index, edges) in edges_by_label.iter().enumerate() {
        if edges.is_empty() {
            continue;
        }
        let label = label_index as u16;
        let lattice_rings = stitch_edges(edges)?;
        rings.extend(disambiguate_saddles(label, lattice_rings));
    }
    Ok(rings)
}
pub(super) fn extract_silhouette_contours(
    artifact: &PreprocessArtifact,
) -> Result<Vec<GridRing>, String> {
    artifact.validate_contract()?;
    if artifact
        .alpha_mask
        .iter()
        .any(|alpha| (1..255).contains(alpha))
    {
        let subpixel = extract_alpha_isolines(artifact)?;
        if !subpixel.is_empty() {
            return Ok(subpixel);
        }
    }
    extract_contours(artifact)
}

#[derive(Clone, Copy, Debug)]
struct IsoSegment {
    start: GridPoint,
    end: GridPoint,
}

fn extract_alpha_isolines(artifact: &PreprocessArtifact) -> Result<Vec<GridRing>, String> {
    const ISO_ALPHA: f64 = 127.5;
    let width = artifact.width_px as usize;
    let height = artifact.height_px as usize;
    let sample = |grid_x: usize, grid_y: usize| -> f64 {
        if grid_x == 0 || grid_y == 0 || grid_x > width || grid_y > height {
            0.0
        } else {
            f64::from(artifact.alpha_mask[(grid_y - 1) * width + (grid_x - 1)])
        }
    };

    let mut segments = Vec::new();
    for grid_y in 0..=height {
        for grid_x in 0..=width {
            let values = [
                sample(grid_x, grid_y),
                sample(grid_x + 1, grid_y),
                sample(grid_x + 1, grid_y + 1),
                sample(grid_x, grid_y + 1),
            ];
            let mut crossings = Vec::<(u8, GridPoint)>::new();
            for edge in 0..4_u8 {
                let (first, second) = match edge {
                    0 => (0, 1),
                    1 => (1, 2),
                    2 => (2, 3),
                    3 => (3, 0),
                    _ => unreachable!(),
                };
                if (values[first] >= ISO_ALPHA) == (values[second] >= ISO_ALPHA) {
                    continue;
                }
                crossings.push((
                    edge,
                    iso_crossing(grid_x, grid_y, edge, values[first], values[second]),
                ));
            }
            match crossings.len() {
                0 => {}
                2 => push_oriented_iso_segment(
                    &mut segments,
                    crossings[0].1,
                    crossings[1].1,
                    grid_x,
                    grid_y,
                    values,
                ),
                4 => {
                    let center_is_inside = values.iter().sum::<f64>() * 0.25 >= ISO_ALPHA;
                    let case = values
                        .iter()
                        .enumerate()
                        .fold(0_u8, |mask, (index, value)| {
                            mask | (u8::from(*value >= ISO_ALPHA) << index)
                        });
                    let pairs = match (case, center_is_inside) {
                        (5, true) | (10, false) => [(0, 1), (2, 3)],
                        (5, false) | (10, true) => [(0, 3), (1, 2)],
                        _ => return Err("Ô marching-squares có saddle không hợp lệ".to_string()),
                    };
                    for (first, second) in pairs {
                        push_oriented_iso_segment(
                            &mut segments,
                            crossings[first].1,
                            crossings[second].1,
                            grid_x,
                            grid_y,
                            values,
                        );
                    }
                }
                _ => return Err("Ô marching-squares có số giao điểm lẻ".to_string()),
            }
        }
    }
    stitch_iso_segments(&segments)
}

fn iso_crossing(
    grid_x: usize,
    grid_y: usize,
    edge: u8,
    first_alpha: f64,
    second_alpha: f64,
) -> GridPoint {
    const ISO_ALPHA: f64 = 127.5;
    let denominator = second_alpha - first_alpha;
    let parameter = if denominator.abs() <= f64::EPSILON {
        0.5
    } else {
        ((ISO_ALPHA - first_alpha) / denominator).clamp(0.0, 1.0)
    };
    let left = grid_x as f64 - 0.5;
    let top = grid_y as f64 - 0.5;
    let (x, y) = match edge {
        0 => (left + parameter, top),
        1 => (left + 1.0, top + parameter),
        2 => (left + 1.0 - parameter, top + 1.0),
        3 => (left, top + 1.0 - parameter),
        _ => unreachable!(),
    };
    GridPoint {
        x2: (x * CONTOUR_COORDINATE_SCALE as f64).round() as i64,
        y2: (y * CONTOUR_COORDINATE_SCALE as f64).round() as i64,
    }
}

fn push_oriented_iso_segment(
    segments: &mut Vec<IsoSegment>,
    mut start: GridPoint,
    mut end: GridPoint,
    grid_x: usize,
    grid_y: usize,
    values: [f64; 4],
) {
    if start == end {
        return;
    }
    let start_point = grid_to_float(start);
    let end_point = grid_to_float(end);
    let midpoint_x = (start_point.0 + end_point.0) * 0.5;
    let midpoint_y = (start_point.1 + end_point.1) * 0.5;
    let delta_x = end_point.0 - start_point.0;
    let delta_y = end_point.1 - start_point.1;
    let local_x = (midpoint_x - (grid_x as f64 - 0.5)).clamp(0.0, 1.0);
    let local_y = (midpoint_y - (grid_y as f64 - 0.5)).clamp(0.0, 1.0);
    let gradient_x = (values[1] - values[0]) * (1.0 - local_y) + (values[2] - values[3]) * local_y;
    let gradient_y = (values[3] - values[0]) * (1.0 - local_x) + (values[2] - values[1]) * local_x;
    // Gradient chỉ thẳng về phía alpha tăng. Trong hệ y đi xuống, pháp tuyến
    // phải của segment là (-dy, dx); tích vô hướng dương giữ foreground bên phải.
    if -delta_y * gradient_x + delta_x * gradient_y < 0.0 {
        std::mem::swap(&mut start, &mut end);
    }
    segments.push(IsoSegment { start, end });
}

fn grid_to_float(point: GridPoint) -> (f64, f64) {
    (
        point.x2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
        point.y2 as f64 / CONTOUR_COORDINATE_SCALE as f64,
    )
}

fn stitch_iso_segments(segments: &[IsoSegment]) -> Result<Vec<GridRing>, String> {
    let mut adjacency = HashMap::<GridPoint, Vec<usize>>::new();
    for (index, segment) in segments.iter().enumerate() {
        adjacency.entry(segment.start).or_default().push(index);
        adjacency.entry(segment.end).or_default().push(index);
    }
    let mut used = vec![false; segments.len()];
    let mut rings = Vec::new();

    for first in 0..segments.len() {
        if used[first] {
            continue;
        }
        let start = segments[first].start;
        let mut current_point = start;
        let mut current_segment = first;
        let mut vertices = vec![start];
        let mut orientation_score = 0.0_f64;
        let mut closed = false;
        for _ in 0..=segments.len() {
            if used[current_segment] {
                return Err("Iso-contour dùng lặp segment trước khi khép".to_string());
            }
            used[current_segment] = true;
            let segment = segments[current_segment];
            let (end, orientation) = if segment.start == current_point {
                (segment.end, 1.0)
            } else if segment.end == current_point {
                (segment.start, -1.0)
            } else {
                return Err("Iso-contour mất liên kết tại segment".to_string());
            };
            let delta_x = (segment.end.x2 - segment.start.x2) as f64;
            let delta_y = (segment.end.y2 - segment.start.y2) as f64;
            orientation_score += orientation * delta_x.hypot(delta_y);
            if end == start {
                closed = true;
                break;
            }
            vertices.push(end);
            current_point = end;
            current_segment = adjacency
                .get(&end)
                .and_then(|candidates| candidates.iter().copied().find(|index| !used[*index]))
                .ok_or_else(|| "Iso-contour alpha bị hở sau nội suy".to_string())?;
        }
        if !closed {
            return Err("Iso-contour alpha vượt số segment mà chưa khép".to_string());
        }
        // LOGO-TRAJECTORY (audit 2026-08-25 F-01): mỗi segment đã bỏ phiếu
        // hướng có alpha đặc ở bên phải. Chuẩn hóa theo cả vòng thay vì để
        // hướng segment đầu quyết định outer/hole khi nội suy bị lượng tử.
        let mut vertices = remove_collinear_grid_vertices(vertices);
        if orientation_score < 0.0 {
            vertices.reverse();
        }
        if vertices.len() >= 3 {
            rings.push(GridRing {
                label_index: 0,
                vertices,
                saddle_cuts: 0,
            });
        }
    }
    Ok(rings)
}

fn remove_collinear_grid_vertices(vertices: Vec<GridPoint>) -> Vec<GridPoint> {
    if vertices.len() < 4 {
        return vertices;
    }
    let count = vertices.len();
    (0..count)
        .filter_map(|index| {
            let previous = vertices[(index + count - 1) % count];
            let current = vertices[index];
            let next = vertices[(index + 1) % count];
            let first_x = current.x2 - previous.x2;
            let first_y = current.y2 - previous.y2;
            let second_x = next.x2 - current.x2;
            let second_y = next.y2 - current.y2;
            (first_x * second_y != first_y * second_x).then_some(current)
        })
        .collect()
}
fn collect_boundary_edges(
    labels: &[u16],
    width: usize,
    height: usize,
    palette_len: usize,
) -> Vec<Vec<BoundaryEdge>> {
    let mut edges_by_label = vec![Vec::new(); palette_len];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let label = labels[index];
            let Some(edges) = edges_by_label.get_mut(usize::from(label)) else {
                continue;
            };
            // Tâm pixel là (x + 0,5; y + 0,5), vì vậy biên integer dưới đây
            // chính là lưới half-pixel và vẫn phủ đúng extent 0..width/height.
            let x0 = x as u32;
            let y0 = y as u32;
            let x1 = x0 + 1;
            let y1 = y0 + 1;

            // LOGO-ENGINE-V2 (audit 2026-08-11 Lô C): mọi cạnh hướng sao
            // cho phần tô nằm bên phải. Trong hệ y đi xuống, outer sẽ CW.
            if y == 0 || labels[index - width] != label {
                edges.push(BoundaryEdge::new(
                    LatticePoint { x: x0, y: y0 },
                    LatticePoint { x: x1, y: y0 },
                ));
            }
            if x + 1 == width || labels[index + 1] != label {
                edges.push(BoundaryEdge::new(
                    LatticePoint { x: x1, y: y0 },
                    LatticePoint { x: x1, y: y1 },
                ));
            }
            if y + 1 == height || labels[index + width] != label {
                edges.push(BoundaryEdge::new(
                    LatticePoint { x: x1, y: y1 },
                    LatticePoint { x: x0, y: y1 },
                ));
            }
            if x == 0 || labels[index - 1] != label {
                edges.push(BoundaryEdge::new(
                    LatticePoint { x: x0, y: y1 },
                    LatticePoint { x: x0, y: y0 },
                ));
            }
        }
    }
    edges_by_label
}

impl BoundaryEdge {
    fn new(start: LatticePoint, end: LatticePoint) -> Self {
        let direction = match (
            i64::from(end.x) - i64::from(start.x),
            i64::from(end.y) - i64::from(start.y),
        ) {
            (1, 0) => Direction::East,
            (0, 1) => Direction::South,
            (-1, 0) => Direction::West,
            (0, -1) => Direction::North,
            _ => unreachable!("cạnh biên raster luôn dài đúng một ô"),
        };
        Self {
            start,
            end,
            direction,
        }
    }
}

fn stitch_edges(edges: &[BoundaryEdge]) -> Result<Vec<Vec<LatticePoint>>, String> {
    let mut outgoing = HashMap::<LatticePoint, Vec<usize>>::new();
    for (edge_index, edge) in edges.iter().enumerate() {
        outgoing.entry(edge.start).or_default().push(edge_index);
    }

    let mut used = vec![false; edges.len()];
    let mut rings = Vec::new();
    for first_edge in 0..edges.len() {
        if used[first_edge] {
            continue;
        }

        let start = edges[first_edge].start;
        let mut current_edge = first_edge;
        let mut vertices = vec![start];
        let mut closed = false;

        for _ in 0..=edges.len() {
            if used[current_edge] {
                return Err("Contour dùng lặp một cạnh trước khi khép kín".to_string());
            }
            let edge = edges[current_edge];
            used[current_edge] = true;
            if edge.end == start {
                closed = true;
                break;
            }
            vertices.push(edge.end);
            current_edge = choose_next_edge(edge, &outgoing, edges, &used)
                .ok_or_else(|| "Contour bị hở hoặc mất liên kết tại đỉnh lưới".to_string())?;
        }

        if !closed {
            return Err("Contour vượt số cạnh mà chưa khép kín".to_string());
        }
        let vertices = remove_collinear_vertices(vertices);
        if vertices.len() < 4 {
            return Err("Contour raster suy biến sau khi chuẩn hóa".to_string());
        }
        rings.push(vertices);
    }
    Ok(rings)
}

fn choose_next_edge(
    incoming: BoundaryEdge,
    outgoing: &HashMap<LatticePoint, Vec<usize>>,
    edges: &[BoundaryEdge],
    used: &[bool],
) -> Option<usize> {
    outgoing
        .get(&incoming.end)?
        .iter()
        .copied()
        .filter(|index| !used[*index])
        .min_by_key(|index| turn_rank(incoming.direction, edges[*index].direction))
}

fn turn_rank(incoming: Direction, outgoing: Direction) -> u8 {
    let turn = (outgoing as i8 - incoming as i8).rem_euclid(4);
    match turn {
        1 => 0, // rẽ phải: giữ hai vùng chỉ chạm góc thành hai contour riêng.
        0 => 1,
        3 => 2,
        2 => 3,
        _ => unreachable!(),
    }
}

fn remove_collinear_vertices(vertices: Vec<LatticePoint>) -> Vec<LatticePoint> {
    if vertices.len() < 4 {
        return vertices;
    }
    let count = vertices.len();
    (0..count)
        .filter_map(|index| {
            let previous = vertices[(index + count - 1) % count];
            let current = vertices[index];
            let next = vertices[(index + 1) % count];
            let collinear = (previous.x == current.x && current.x == next.x)
                || (previous.y == current.y && current.y == next.y);
            (!collinear).then_some(current)
        })
        .collect()
}

fn disambiguate_saddles(label_index: u16, lattice_rings: Vec<Vec<LatticePoint>>) -> Vec<GridRing> {
    let mut usage = HashMap::<LatticePoint, usize>::new();
    for vertices in &lattice_rings {
        for point in vertices {
            *usage.entry(*point).or_default() += 1;
        }
    }

    lattice_rings
        .into_iter()
        .map(|vertices| {
            let count = vertices.len();
            let mut resolved = Vec::with_capacity(count + 2);
            let mut saddle_cuts = 0_u64;
            for index in 0..count {
                let previous = vertices[(index + count - 1) % count];
                let current = vertices[index];
                let next = vertices[(index + 1) % count];
                if usage[&current] > 1 {
                    // Hai lượt biên dùng chung một đỉnh là saddle. Vát mỗi
                    // corner về phía pixel foreground để mở kênh chéo rõ ràng.
                    resolved.push(saddle_offset_point(current, previous));
                    resolved.push(saddle_offset_point(current, next));
                    saddle_cuts += 1;
                } else {
                    resolved.push(scaled_point(current));
                }
            }
            GridRing {
                label_index,
                vertices: resolved,
                saddle_cuts,
            }
        })
        .collect()
}

fn scaled_point(point: LatticePoint) -> GridPoint {
    GridPoint {
        x2: i64::from(point.x) * CONTOUR_COORDINATE_SCALE,
        y2: i64::from(point.y) * CONTOUR_COORDINATE_SCALE,
    }
}

fn saddle_offset_point(corner: LatticePoint, neighbor: LatticePoint) -> GridPoint {
    let delta_x = (i64::from(neighbor.x) - i64::from(corner.x)).signum();
    let delta_y = (i64::from(neighbor.y) - i64::from(corner.y)).signum();
    GridPoint {
        x2: i64::from(corner.x) * CONTOUR_COORDINATE_SCALE
            + delta_x * (CONTOUR_COORDINATE_SCALE / 2),
        y2: i64::from(corner.y) * CONTOUR_COORDINATE_SCALE
            + delta_y * (CONTOUR_COORDINATE_SCALE / 2),
    }
}
