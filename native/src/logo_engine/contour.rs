//! Trích biên chính xác trên lưới pixel cho Logo Engine v2.

#![allow(dead_code)]

use super::scene::PreprocessArtifact;
use std::collections::HashMap;

pub(super) const CONTOUR_COORDINATE_SCALE: i64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
        x2: i64::from(corner.x) * CONTOUR_COORDINATE_SCALE + delta_x,
        y2: i64::from(corner.y) * CONTOUR_COORDINATE_SCALE + delta_y,
    }
}
