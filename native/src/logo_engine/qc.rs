//! QC độc lập trên chuỗi SVG cuối của Logo Engine v2.

#![allow(dead_code)]

use super::scene::{RingRole, SceneGeometry, VectorScene};
use super::svg_writer::PhysicalSizeMm;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ArtifactQcOptions {
    pub(crate) expected_physical_size_mm: Option<PhysicalSizeMm>,
    pub(crate) raster_scale: u32,
    /// Các ngân sách này do scheduler/caller quyết định, không hard-cap toàn cục.
    pub(crate) max_input_bytes: Option<usize>,
    pub(crate) max_raster_pixels: Option<usize>,
    pub(crate) min_iou: Option<f64>,
    pub(crate) max_mae: Option<f64>,
}

impl Default for ArtifactQcOptions {
    fn default() -> Self {
        Self {
            expected_physical_size_mm: None,
            raster_scale: 4,
            max_input_bytes: None,
            max_raster_pixels: None,
            min_iou: None,
            max_mae: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ArtifactQcReport {
    pub(crate) width_px: u32,
    pub(crate) height_px: u32,
    pub(crate) physical_size_mm: Option<PhysicalSizeMm>,
    pub(crate) outer_count: usize,
    pub(crate) hole_count: usize,
    pub(crate) iou: Option<f64>,
    pub(crate) mae: Option<f64>,
    /// Góc đổi hướng lớn nhất giữa mọi cặp segment kề nhau trên SVG cuối.
    pub(crate) max_artifact_tangent_jump_degrees: f64,
    pub(crate) artifact_sha256: String,
    pub(crate) byte_len: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct ScanlineEdge {
    start: Point,
    end: Point,
    end_row: usize,
    /// Thay đổi winding khi quét mẫu từ trái sang phải qua cạnh này.
    winding_delta: i32,
}

#[derive(Clone, Debug)]
enum ParsedSegment {
    Line {
        to: Point,
    },
    Cubic {
        control_1: Point,
        control_2: Point,
        to: Point,
    },
}

#[derive(Clone, Debug)]
struct ParsedSubpath {
    start: Point,
    segments: Vec<ParsedSegment>,
    closed: bool,
}

#[derive(Clone, Debug)]
struct ParsedPath {
    subpaths: Vec<ParsedSubpath>,
    fill: Option<[u8; 4]>,
    stroke: Option<[u8; 4]>,
    stroke_width: f64,
}

#[derive(Clone, Debug)]
struct ParsedSvg {
    width_px: u32,
    height_px: u32,
    physical_size_mm: Option<PhysicalSizeMm>,
    paths: Vec<ParsedPath>,
}

pub(crate) fn inspect_svg_artifact(
    svg: &str,
    expected_scene: &VectorScene,
    reference_rgba: Option<&[u8]>,
    options: ArtifactQcOptions,
) -> Result<ArtifactQcReport, String> {
    inspect_svg_artifact_cancellable(svg, expected_scene, reference_rgba, options, &mut || false)
}

pub(crate) fn inspect_svg_artifact_cancellable(
    svg: &str,
    expected_scene: &VectorScene,
    reference_rgba: Option<&[u8]>,
    options: ArtifactQcOptions,
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<ArtifactQcReport, String> {
    ensure_qc_not_cancelled(is_cancelled)?;
    expected_scene.validate_contract()?;
    validate_options(options)?;
    if svg.trim().is_empty() {
        return Err("SVG artifact rỗng".to_string());
    }
    if options
        .max_input_bytes
        .is_some_and(|budget| svg.len() > budget)
    {
        return Err(format!(
            "SVG artifact vượt ngân sách caller: {} byte",
            svg.len()
        ));
    }

    let parsed = parse_svg(svg)?;
    ensure_qc_not_cancelled(is_cancelled)?;
    if parsed.width_px != expected_scene.width_px || parsed.height_px != expected_scene.height_px {
        return Err("viewBox SVG không khớp VectorScene".to_string());
    }
    match (options.expected_physical_size_mm, parsed.physical_size_mm) {
        (Some(expected), Some(actual)) if physical_size_matches(expected, actual) => {}
        (Some(_), Some(_)) => return Err("Kích thước mm artifact không khớp xác nhận".to_string()),
        (Some(_), None) => return Err("SVG artifact thiếu kích thước mm đã xác nhận".to_string()),
        (None, Some(_)) => return Err("SVG artifact có kích thước mm ngoài hợp đồng".to_string()),
        (None, None) => {}
    }

    let (outer_count, hole_count, max_artifact_tangent_jump_degrees) =
        inspect_parsed_geometry(&parsed, is_cancelled)?;
    ensure_qc_not_cancelled(is_cancelled)?;
    let (expected_outer, expected_holes) = scene_topology_counts(expected_scene);
    if outer_count != expected_outer || hole_count != expected_holes {
        return Err(format!(
            "Topology artifact lệch scene: outer {outer_count}/{expected_outer}, hole {hole_count}/{expected_holes}"
        ));
    }

    let (iou, mae) = if let Some(reference) = reference_rgba {
        let expected_len = usize::try_from(expected_scene.width_px)
            .ok()
            .and_then(|width| {
                usize::try_from(expected_scene.height_px)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "Kích thước reference RGBA vượt giới hạn biểu diễn".to_string())?;
        if reference.len() != expected_len {
            return Err("Reference RGBA không khớp kích thước canvas".to_string());
        }
        let rendered = render_svg(&parsed, options, is_cancelled)?;
        let metrics = compare_raster(
            &rendered,
            reference,
            parsed.width_px as usize,
            parsed.height_px as usize,
            options.raster_scale as usize,
            is_cancelled,
        )?;
        if options
            .min_iou
            .is_some_and(|threshold| metrics.0 < threshold)
        {
            return Err(format!(
                "IoU artifact {:.6} thấp hơn ngưỡng {:.6}",
                metrics.0,
                options.min_iou.unwrap_or_default()
            ));
        }
        if options
            .max_mae
            .is_some_and(|threshold| metrics.1 > threshold)
        {
            return Err(format!(
                "MAE artifact {:.6} vượt ngưỡng {:.6}",
                metrics.1,
                options.max_mae.unwrap_or_default()
            ));
        }
        (Some(metrics.0), Some(metrics.1))
    } else {
        (None, None)
    };

    Ok(ArtifactQcReport {
        width_px: parsed.width_px,
        height_px: parsed.height_px,
        physical_size_mm: parsed.physical_size_mm,
        outer_count,
        hole_count,
        iou,
        mae,
        max_artifact_tangent_jump_degrees,
        artifact_sha256: format!("{:x}", Sha256::digest(svg.as_bytes())),
        byte_len: svg.len(),
    })
}

fn ensure_qc_not_cancelled(is_cancelled: &mut dyn FnMut() -> bool) -> Result<(), String> {
    if is_cancelled() {
        Err("Đã hủy QC artifact logo.".to_string())
    } else {
        Ok(())
    }
}

fn validate_options(options: ArtifactQcOptions) -> Result<(), String> {
    if options.raster_scale == 0 {
        return Err("Raster scale QC phải lớn hơn 0".to_string());
    }
    if options
        .min_iou
        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
    {
        return Err("Ngưỡng IoU phải nằm trong khoảng 0–1".to_string());
    }
    if options
        .max_mae
        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
    {
        return Err("Ngưỡng MAE phải nằm trong khoảng 0–1".to_string());
    }
    Ok(())
}

fn parse_svg(svg: &str) -> Result<ParsedSvg, String> {
    let root_start = svg
        .find("<svg ")
        .ok_or_else(|| "SVG thiếu thẻ gốc".to_string())?;
    let root_end = svg[root_start..]
        .find('>')
        .map(|offset| root_start + offset)
        .ok_or_else(|| "Thẻ SVG gốc không khép".to_string())?;
    if !svg.trim_end().ends_with("</svg>") {
        return Err("SVG thiếu thẻ đóng".to_string());
    }
    let root_attributes = parse_attributes(&svg[root_start..=root_end])?;
    let view_box = root_attributes
        .get("viewBox")
        .ok_or_else(|| "SVG thiếu viewBox".to_string())?
        .split_whitespace()
        .map(parse_number)
        .collect::<Result<Vec<_>, _>>()?;
    if view_box.len() != 4 || view_box[0] != 0.0 || view_box[1] != 0.0 {
        return Err("viewBox SVG không hợp lệ".to_string());
    }
    let width_px = exact_u32(view_box[2], "chiều rộng viewBox")?;
    let height_px = exact_u32(view_box[3], "chiều cao viewBox")?;
    if width_px == 0 || height_px == 0 {
        return Err("viewBox SVG phải lớn hơn 0".to_string());
    }
    let physical_size_mm = parse_canvas_size(&root_attributes, width_px, height_px)?;

    let mut paths = Vec::new();
    let mut search_from = root_end + 1;
    while let Some(relative_start) = svg[search_from..].find("<path ") {
        let path_start = search_from + relative_start;
        let path_end = svg[path_start..]
            .find("/>")
            .map(|offset| path_start + offset + 1)
            .ok_or_else(|| "Thẻ path SVG không tự đóng".to_string())?;
        paths.push(parse_path(&svg[path_start..=path_end])?);
        search_from = path_end + 1;
    }
    if paths.is_empty() {
        return Err("SVG không có path".to_string());
    }
    Ok(ParsedSvg {
        width_px,
        height_px,
        physical_size_mm,
        paths,
    })
}

fn parse_path(tag: &str) -> Result<ParsedPath, String> {
    let attributes = parse_attributes(tag)?;
    let path_data = attributes
        .get("d")
        .ok_or_else(|| "Path SVG thiếu dữ liệu d".to_string())?;
    let subpaths = parse_path_data(path_data)?;
    let fill = match attributes.get("fill").map(String::as_str) {
        Some("none") | None => None,
        Some(color) => {
            if attributes.get("fill-rule").map(String::as_str) != Some("nonzero") {
                return Err("Vùng tô SVG phải dùng fill-rule nonzero".to_string());
            }
            Some(parse_paint(
                color,
                attributes.get("fill-opacity").map(String::as_str),
            )?)
        }
    };
    let stroke = match attributes.get("stroke") {
        Some(color) => Some(parse_paint(
            color,
            attributes.get("stroke-opacity").map(String::as_str),
        )?),
        None => None,
    };
    let stroke_width = match attributes.get("stroke-width") {
        Some(value) => parse_number(value)?,
        None => 0.0,
    };
    if fill.is_none() && stroke.is_none() {
        return Err("Path SVG không có fill hoặc stroke".to_string());
    }
    if stroke.is_some() && (!stroke_width.is_finite() || stroke_width <= 0.0) {
        return Err("Stroke SVG có độ rộng không hợp lệ".to_string());
    }
    Ok(ParsedPath {
        subpaths,
        fill,
        stroke,
        stroke_width,
    })
}

fn parse_path_data(data: &str) -> Result<Vec<ParsedSubpath>, String> {
    let tokens = data.split_whitespace().collect::<Vec<_>>();
    let mut index = 0;
    let mut subpaths = Vec::new();
    let mut current: Option<ParsedSubpath> = None;
    while index < tokens.len() {
        match tokens[index] {
            "M" => {
                if let Some(path) = current.take() {
                    subpaths.push(path);
                }
                let point = parse_point_tokens(&tokens, index + 1)?;
                current = Some(ParsedSubpath {
                    start: point,
                    segments: Vec::new(),
                    closed: false,
                });
                index += 3;
            }
            "L" => {
                let point = parse_point_tokens(&tokens, index + 1)?;
                current
                    .as_mut()
                    .ok_or_else(|| "L xuất hiện trước M".to_string())?
                    .segments
                    .push(ParsedSegment::Line { to: point });
                index += 3;
            }
            "C" => {
                if index + 6 >= tokens.len() {
                    return Err("Lệnh C thiếu tọa độ".to_string());
                }
                let control_1 = parse_point_tokens(&tokens, index + 1)?;
                let control_2 = parse_point_tokens(&tokens, index + 3)?;
                let to = parse_point_tokens(&tokens, index + 5)?;
                current
                    .as_mut()
                    .ok_or_else(|| "C xuất hiện trước M".to_string())?
                    .segments
                    .push(ParsedSegment::Cubic {
                        control_1,
                        control_2,
                        to,
                    });
                index += 7;
            }
            "Z" => {
                let mut path = current
                    .take()
                    .ok_or_else(|| "Z xuất hiện trước M".to_string())?;
                path.closed = true;
                subpaths.push(path);
                index += 1;
            }
            command => return Err(format!("Lệnh path SVG không hỗ trợ: {command}")),
        }
    }
    if let Some(path) = current {
        subpaths.push(path);
    }
    if subpaths.is_empty() || subpaths.iter().any(|path| path.segments.is_empty()) {
        return Err("Path SVG rỗng hoặc suy biến".to_string());
    }
    Ok(subpaths)
}

fn parse_attributes(tag: &str) -> Result<BTreeMap<String, String>, String> {
    let bytes = tag.as_bytes();
    let mut index = tag
        .find(char::is_whitespace)
        .ok_or_else(|| "Thẻ XML không có thuộc tính".to_string())?;
    let mut attributes = BTreeMap::new();
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] == b'>' || bytes[index] == b'/' {
            break;
        }
        let key_start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'=' {
            index += 1;
        }
        let key = &tag[key_start..index];
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'=' {
            return Err("Thuộc tính XML thiếu dấu =".to_string());
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'"' {
            return Err("Thuộc tính XML phải dùng dấu ngoặc kép".to_string());
        }
        index += 1;
        let value_start = index;
        while index < bytes.len() && bytes[index] != b'"' {
            index += 1;
        }
        if index >= bytes.len() {
            return Err("Thuộc tính XML không khép".to_string());
        }
        let value = tag[value_start..index].to_string();
        index += 1;
        if attributes.insert(key.to_string(), value).is_some() {
            return Err("Thuộc tính XML bị lặp".to_string());
        }
    }
    Ok(attributes)
}

fn parse_point_tokens(tokens: &[&str], start: usize) -> Result<Point, String> {
    if start + 1 >= tokens.len() {
        return Err("Lệnh path thiếu tọa độ".to_string());
    }
    Ok(Point {
        x: parse_number(tokens[start])?,
        y: parse_number(tokens[start + 1])?,
    })
}

fn parse_number(value: &str) -> Result<f64, String> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| "SVG chứa số không hợp lệ".to_string())?;
    if !parsed.is_finite() {
        return Err("SVG chứa NaN hoặc Infinity".to_string());
    }
    Ok(parsed)
}

fn exact_u32(value: f64, field: &str) -> Result<u32, String> {
    if value <= 0.0 || value > f64::from(u32::MAX) || value.fract() != 0.0 {
        return Err(format!("{field} không hợp lệ"));
    }
    Ok(value as u32)
}

fn parse_canvas_size(
    attributes: &BTreeMap<String, String>,
    width_px: u32,
    height_px: u32,
) -> Result<Option<PhysicalSizeMm>, String> {
    let width = attributes
        .get("width")
        .ok_or_else(|| "SVG thiếu chiều rộng".to_string())?;
    let height = attributes
        .get("height")
        .ok_or_else(|| "SVG thiếu chiều cao".to_string())?;
    match (width.strip_suffix("mm"), height.strip_suffix("mm")) {
        (Some(width), Some(height)) => {
            let width_mm = parse_number(width)?;
            let height_mm = parse_number(height)?;
            if width_mm <= 0.0 || height_mm <= 0.0 {
                return Err("Kích thước mm phải lớn hơn 0".to_string());
            }
            Ok(Some(PhysicalSizeMm {
                width_mm,
                height_mm,
            }))
        }
        (None, None) => {
            if exact_u32(parse_number(width)?, "chiều rộng SVG")? != width_px
                || exact_u32(parse_number(height)?, "chiều cao SVG")? != height_px
            {
                return Err("Kích thước pixel SVG không khớp viewBox".to_string());
            }
            Ok(None)
        }
        _ => Err("SVG phải dùng cùng đơn vị cho width/height".to_string()),
    }
}

fn parse_paint(color: &str, opacity: Option<&str>) -> Result<[u8; 4], String> {
    let hex = color
        .strip_prefix('#')
        .ok_or_else(|| "Màu SVG phải có dạng #RRGGBB".to_string())?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Màu SVG phải có dạng #RRGGBB".to_string());
    }
    let parse =
        |range| u8::from_str_radix(&hex[range], 16).map_err(|_| "Màu SVG không hợp lệ".to_string());
    let alpha = match opacity {
        Some(value) => {
            let value = parse_number(value)?;
            if !(0.0..=1.0).contains(&value) {
                return Err("Opacity SVG phải nằm trong khoảng 0–1".to_string());
            }
            (value * 255.0).round() as u8
        }
        None => 255,
    };
    Ok([parse(0..2)?, parse(2..4)?, parse(4..6)?, alpha])
}

fn inspect_parsed_geometry(
    parsed: &ParsedSvg,
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<(usize, usize, f64), String> {
    let mut outer = 0;
    let mut holes = 0;
    let mut max_tangent_jump_degrees = 0.0_f64;
    for (path_index, path) in parsed.paths.iter().enumerate() {
        for (subpath_index, subpath) in path.subpaths.iter().enumerate() {
            ensure_qc_not_cancelled(is_cancelled)?;
            let points = flatten_subpath(subpath, 0.01)?;
            reject_self_intersection(
                &points,
                subpath.closed,
                path_index,
                subpath_index,
                is_cancelled,
            )?;
            max_tangent_jump_degrees =
                max_tangent_jump_degrees.max(subpath_max_tangent_jump_degrees(subpath));

            if path.fill.is_none() {
                continue;
            }
            if !subpath.closed {
                return Err("Fill path SVG phải khép kín".to_string());
            }
            let area = signed_area_twice(&points);
            if area > 0.0 {
                outer += 1;
            } else if area < 0.0 {
                holes += 1;
            } else {
                return Err("Subpath SVG có diện tích bằng 0".to_string());
            }
        }
    }
    Ok((outer, holes, max_tangent_jump_degrees))
}

#[derive(Clone, Copy, Debug)]
struct FlatEdge {
    start: Point,
    end: Point,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    source_index: usize,
}

fn reject_self_intersection(
    points: &[Point],
    closed: bool,
    path_index: usize,
    subpath_index: usize,
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<(), String> {
    let edge_count = if closed {
        points.len()
    } else {
        points.len().saturating_sub(1)
    };
    if edge_count < 2 {
        return Ok(());
    }

    let mut edges = Vec::with_capacity(edge_count);
    let mut extent = 1.0_f64;
    for index in 0..edge_count {
        let start = points[index];
        let end = points[(index + 1) % points.len()];
        if (start.x - end.x).hypot(start.y - end.y) <= f64::EPSILON {
            continue;
        }
        extent = extent
            .max((start.x - end.x).abs())
            .max((start.y - end.y).abs())
            .max(start.x.abs())
            .max(start.y.abs())
            .max(end.x.abs())
            .max(end.y.abs());
        edges.push(FlatEdge {
            start,
            end,
            min_x: start.x.min(end.x),
            max_x: start.x.max(end.x),
            min_y: start.y.min(end.y),
            max_y: start.y.max(end.y),
            source_index: index,
        });
    }
    if edges.len() < 2 {
        return Ok(());
    }

    // PERF (audit 2026-08-25 §LOGO-QC.02): sweep theo min/max X giảm số cặp
    // cần thử; không duyệt mù O(n²) khi đường cong được flatten nhiều điểm.
    let epsilon = 1.0e-8 * extent.max(1.0);
    let mut order = (0..edges.len()).collect::<Vec<_>>();
    order.sort_unstable_by(|left, right| {
        edges[*left]
            .min_x
            .total_cmp(&edges[*right].min_x)
            .then_with(|| edges[*left].max_x.total_cmp(&edges[*right].max_x))
    });
    let mut active = Vec::<usize>::new();

    for current_index in order {
        ensure_qc_not_cancelled(is_cancelled)?;
        let current = edges[current_index];
        active.retain(|index| edges[*index].max_x + epsilon >= current.min_x);
        for &other_index in &active {
            let other = edges[other_index];
            if current.max_y + epsilon < other.min_y || other.max_y + epsilon < current.min_y {
                continue;
            }
            if adjacent_edges(current.source_index, other.source_index, edge_count, closed) {
                continue;
            }
            if segments_intersect_beyond_shared_endpoint(
                current.start,
                current.end,
                other.start,
                other.end,
                epsilon,
            ) {
                return Err(format!(
                    "Artifact SVG tự giao cắt tại path {path_index}, subpath {subpath_index} (cạnh {} và {})",
                    current.source_index, other.source_index
                ));
            }
        }
        active.push(current_index);
    }
    Ok(())
}

fn adjacent_edges(first: usize, second: usize, edge_count: usize, closed: bool) -> bool {
    if first.abs_diff(second) == 1 {
        return true;
    }
    closed && ((first == 0 && second + 1 == edge_count) || (second == 0 && first + 1 == edge_count))
}

fn segments_intersect_beyond_shared_endpoint(
    first_start: Point,
    first_end: Point,
    second_start: Point,
    second_end: Point,
    epsilon: f64,
) -> bool {
    if !bbox_overlaps(first_start, first_end, second_start, second_end, epsilon) {
        return false;
    }

    let first_orientation_start = cross(first_start, first_end, second_start);
    let first_orientation_end = cross(first_start, first_end, second_end);
    let second_orientation_start = cross(second_start, second_end, first_start);
    let second_orientation_end = cross(second_start, second_end, first_end);
    let first_cross_epsilon = segment_cross_epsilon(first_start, first_end, epsilon);
    let second_cross_epsilon = segment_cross_epsilon(second_start, second_end, epsilon);
    let proper_crossing = opposite_sign(
        first_orientation_start,
        first_orientation_end,
        first_cross_epsilon,
    ) && opposite_sign(
        second_orientation_start,
        second_orientation_end,
        second_cross_epsilon,
    );
    if proper_crossing {
        return true;
    }

    let shared_endpoint = points_equal(first_start, second_start, epsilon)
        || points_equal(first_start, second_end, epsilon)
        || points_equal(first_end, second_start, epsilon)
        || points_equal(first_end, second_end, epsilon);
    let endpoint_touches_interior =
        point_on_segment_strict(first_start, second_start, second_end, epsilon)
            || point_on_segment_strict(first_end, second_start, second_end, epsilon)
            || point_on_segment_strict(second_start, first_start, first_end, epsilon)
            || point_on_segment_strict(second_end, first_start, first_end, epsilon);
    if endpoint_touches_interior {
        return true;
    }

    let collinear = first_orientation_start.abs() <= first_cross_epsilon
        && first_orientation_end.abs() <= first_cross_epsilon
        && second_orientation_start.abs() <= second_cross_epsilon
        && second_orientation_end.abs() <= second_cross_epsilon;
    if collinear {
        let overlap = projected_overlap_length(first_start, first_end, second_start, second_end);
        if overlap > epsilon {
            return true;
        }
    }

    if shared_endpoint {
        false
    } else {
        point_on_segment(first_start, second_start, second_end, epsilon)
            || point_on_segment(first_end, second_start, second_end, epsilon)
            || point_on_segment(second_start, first_start, first_end, epsilon)
            || point_on_segment(second_end, first_start, first_end, epsilon)
    }
}

fn bbox_overlaps(
    first_start: Point,
    first_end: Point,
    second_start: Point,
    second_end: Point,
    epsilon: f64,
) -> bool {
    first_start.x.min(first_end.x) <= second_start.x.max(second_end.x) + epsilon
        && second_start.x.min(second_end.x) <= first_start.x.max(first_end.x) + epsilon
        && first_start.y.min(first_end.y) <= second_start.y.max(second_end.y) + epsilon
        && second_start.y.min(second_end.y) <= first_start.y.max(first_end.y) + epsilon
}

fn opposite_sign(first: f64, second: f64, epsilon: f64) -> bool {
    (first > epsilon && second < -epsilon) || (first < -epsilon && second > epsilon)
}

fn points_equal(first: Point, second: Point, epsilon: f64) -> bool {
    (first.x - second.x).abs() <= epsilon && (first.y - second.y).abs() <= epsilon
}

fn point_on_segment(point: Point, start: Point, end: Point, epsilon: f64) -> bool {
    cross(start, end, point).abs() <= segment_cross_epsilon(start, end, epsilon)
        && point.x >= start.x.min(end.x) - epsilon
        && point.x <= start.x.max(end.x) + epsilon
        && point.y >= start.y.min(end.y) - epsilon
        && point.y <= start.y.max(end.y) + epsilon
}

fn segment_cross_epsilon(start: Point, end: Point, coordinate_epsilon: f64) -> f64 {
    let length = (end.x - start.x).hypot(end.y - start.y);
    coordinate_epsilon * length.max(coordinate_epsilon)
}

fn point_on_segment_strict(point: Point, start: Point, end: Point, epsilon: f64) -> bool {
    point_on_segment(point, start, end, epsilon)
        && !points_equal(point, start, epsilon)
        && !points_equal(point, end, epsilon)
}

fn projected_overlap_length(
    first_start: Point,
    first_end: Point,
    second_start: Point,
    second_end: Point,
) -> f64 {
    let use_x = (first_end.x - first_start.x).abs() >= (first_end.y - first_start.y).abs();
    let project = |point: Point| if use_x { point.x } else { point.y };
    let first_min = project(first_start).min(project(first_end));
    let first_max = project(first_start).max(project(first_end));
    let second_min = project(second_start).min(project(second_end));
    let second_max = project(second_start).max(project(second_end));
    (first_max.min(second_max) - first_min.max(second_min)).max(0.0)
}

fn subpath_max_tangent_jump_degrees(subpath: &ParsedSubpath) -> f64 {
    let mut vectors = Vec::<(Point, Point)>::with_capacity(subpath.segments.len() + 1);
    let mut current = subpath.start;
    for segment in &subpath.segments {
        let (end, outgoing, incoming) = segment_tangent_vectors(current, segment);
        vectors.push((outgoing, incoming));
        current = end;
    }
    if subpath.closed && !points_equal(current, subpath.start, 1.0e-9) {
        let closure = Point {
            x: subpath.start.x - current.x,
            y: subpath.start.y - current.y,
        };
        vectors.push((closure, closure));
    }
    if vectors.len() < 2 {
        return 0.0;
    }

    let mut maximum = 0.0_f64;
    let join_count = if subpath.closed {
        vectors.len()
    } else {
        vectors.len() - 1
    };
    for index in 0..join_count {
        let next = (index + 1) % vectors.len();
        if let Some(angle) = angle_between(vectors[index].1, vectors[next].0) {
            maximum = maximum.max(angle);
        }
    }
    maximum
}

fn segment_tangent_vectors(start: Point, segment: &ParsedSegment) -> (Point, Point, Point) {
    match segment {
        ParsedSegment::Line { to } => {
            let vector = Point {
                x: to.x - start.x,
                y: to.y - start.y,
            };
            (*to, vector, vector)
        }
        ParsedSegment::Cubic {
            control_1,
            control_2,
            to,
        } => {
            let chord = Point {
                x: to.x - start.x,
                y: to.y - start.y,
            };
            let outgoing = first_nonzero_vector(
                Point {
                    x: control_1.x - start.x,
                    y: control_1.y - start.y,
                },
                Point {
                    x: control_2.x - start.x,
                    y: control_2.y - start.y,
                },
                chord,
            );
            let incoming = first_nonzero_vector(
                Point {
                    x: to.x - control_2.x,
                    y: to.y - control_2.y,
                },
                Point {
                    x: to.x - control_1.x,
                    y: to.y - control_1.y,
                },
                chord,
            );
            (*to, outgoing, incoming)
        }
    }
}

fn first_nonzero_vector(first: Point, second: Point, fallback: Point) -> Point {
    if first.x.hypot(first.y) > f64::EPSILON {
        first
    } else if second.x.hypot(second.y) > f64::EPSILON {
        second
    } else {
        fallback
    }
}

fn angle_between(first: Point, second: Point) -> Option<f64> {
    let first_length = first.x.hypot(first.y);
    let second_length = second.x.hypot(second.y);
    if first_length <= f64::EPSILON || second_length <= f64::EPSILON {
        // LOGO-QC (audit 2026-08-25 §LOGO-QC.03): vector tiếp tuyến suy biến không được
        // rơi về “mượt” giả; báo góc cực đại để downstream có thể cảnh báo.
        return Some(180.0);
    }
    let cosine = ((first.x * second.x + first.y * second.y) / (first_length * second_length))
        .clamp(-1.0, 1.0);
    Some(cosine.acos().to_degrees())
}

fn scene_topology_counts(scene: &VectorScene) -> (usize, usize) {
    let mut outer = 0;
    let mut holes = 0;
    for layer in &scene.layers {
        for geometry in &layer.geometry {
            if let SceneGeometry::FillRegion { rings } = geometry {
                for ring in rings {
                    match ring.role {
                        RingRole::Outer => outer += 1,
                        RingRole::Hole => holes += 1,
                    }
                }
            }
        }
    }
    (outer, holes)
}

fn render_svg(
    parsed: &ParsedSvg,
    options: ArtifactQcOptions,
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<Vec<[u8; 4]>, String> {
    let scale = options.raster_scale as usize;
    let width = usize::try_from(parsed.width_px)
        .ok()
        .and_then(|value| value.checked_mul(scale))
        .ok_or_else(|| "Chiều rộng raster QC vượt giới hạn biểu diễn".to_string())?;
    let height = usize::try_from(parsed.height_px)
        .ok()
        .and_then(|value| value.checked_mul(scale))
        .ok_or_else(|| "Chiều cao raster QC vượt giới hạn biểu diễn".to_string())?;
    let pixel_count = width
        .checked_mul(height)
        .ok_or_else(|| "Raster QC vượt giới hạn biểu diễn".to_string())?;
    if options
        .max_raster_pixels
        .is_some_and(|budget| pixel_count > budget)
    {
        return Err(format!(
            "Raster QC vượt ngân sách caller: {pixel_count} pixel"
        ));
    }
    let mut raster = vec![[0_u8; 4]; pixel_count];
    let flatten_tolerance = 0.1 / f64::from(options.raster_scale);

    for path in &parsed.paths {
        ensure_qc_not_cancelled(is_cancelled)?;
        let flattened = path
            .subpaths
            .iter()
            .map(|subpath| {
                flatten_subpath(subpath, flatten_tolerance)
                    .map(|polyline| (polyline, subpath.closed))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(fill) = path.fill {
            // PERF (audit 2026-08-11 §LOGO-QC.01): thuật toán cũ thử winding
            // của mọi pixel với mọi cạnh, làm preview thật chạy hàng phút.
            // Active-edge scanline giữ đúng fill-rule nonzero nhưng chỉ duyệt
            // những cạnh thực sự cắt từng hàng mẫu.
            rasterize_nonzero_fill(
                &mut raster,
                width,
                height,
                scale,
                &flattened,
                fill,
                is_cancelled,
            )?;
        }
        if let Some(stroke) = path.stroke {
            let radius = path.stroke_width / 2.0;
            for y in 0..height {
                ensure_qc_not_cancelled(is_cancelled)?;
                for x in 0..width {
                    let sample = Point {
                        x: (x as f64 + 0.5) / scale as f64,
                        y: (y as f64 + 0.5) / scale as f64,
                    };
                    if flattened.iter().any(|(polyline, closed)| {
                        polyline_distance(sample, polyline, *closed) <= radius
                    }) {
                        blend_over(&mut raster[y * width + x], stroke);
                    }
                }
            }
        }
    }
    Ok(raster)
}

fn rasterize_nonzero_fill(
    raster: &mut [[u8; 4]],
    width: usize,
    height: usize,
    scale: usize,
    flattened: &[(Vec<Point>, bool)],
    fill: [u8; 4],
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<(), String> {
    let mut starts = vec![Vec::<ScanlineEdge>::new(); height];
    for (polygon, closed) in flattened {
        if !closed {
            return Err("Fill path SVG phải khép kín".to_string());
        }
        for pair in polygon.windows(2) {
            add_scanline_edge(&mut starts, height, scale, pair[0], pair[1]);
        }
        if polygon.len() > 1 {
            add_scanline_edge(
                &mut starts,
                height,
                scale,
                polygon[polygon.len() - 1],
                polygon[0],
            );
        }
    }

    let mut active = Vec::<ScanlineEdge>::new();
    let mut events = Vec::<(usize, i32)>::new();
    for (row, row_starts) in starts.iter().enumerate() {
        ensure_qc_not_cancelled(is_cancelled)?;
        active.retain(|edge| edge.end_row > row);
        active.extend(row_starts.iter().copied());
        let sample_y = (row as f64 + 0.5) / scale as f64;
        events.clear();
        events.extend(active.iter().map(|edge| {
            let parameter = (sample_y - edge.start.y) / (edge.end.y - edge.start.y);
            let intersection_x = edge.start.x + (edge.end.x - edge.start.x) * parameter;
            (
                scanline_event_index(intersection_x, scale, width),
                edge.winding_delta,
            )
        }));
        events.sort_unstable_by_key(|event| event.0);

        let mut cursor = 0_usize;
        let mut winding = 0_i32;
        let mut event_index = 0_usize;
        while event_index < events.len() {
            let column = events[event_index].0;
            if winding != 0 {
                blend_span(raster, row, width, cursor, column, fill);
            }
            let mut delta = 0_i32;
            while event_index < events.len() && events[event_index].0 == column {
                delta += events[event_index].1;
                event_index += 1;
            }
            winding += delta;
            cursor = column;
        }
        if winding != 0 {
            blend_span(raster, row, width, cursor, width, fill);
        }
    }
    Ok(())
}

fn add_scanline_edge(
    starts: &mut [Vec<ScanlineEdge>],
    height: usize,
    scale: usize,
    first: Point,
    second: Point,
) {
    if (first.y - second.y).abs() <= f64::EPSILON {
        return;
    }
    let minimum_y = first.y.min(second.y);
    let maximum_y = first.y.max(second.y);
    let start_row = scanline_event_index(minimum_y, scale, height);
    let end_row = scanline_event_index(maximum_y, scale, height);
    if start_row >= end_row || start_row >= height {
        return;
    }
    starts[start_row].push(ScanlineEdge {
        start: first,
        end: second,
        end_row,
        winding_delta: if first.y < second.y { -1 } else { 1 },
    });
}

fn scanline_event_index(coordinate: f64, scale: usize, limit: usize) -> usize {
    let index = (coordinate * scale as f64 - 0.5).ceil();
    if index <= 0.0 {
        0
    } else if index >= limit as f64 {
        limit
    } else {
        index as usize
    }
}

fn blend_span(
    raster: &mut [[u8; 4]],
    row: usize,
    width: usize,
    start: usize,
    end: usize,
    fill: [u8; 4],
) {
    let row_offset = row * width;
    for target in &mut raster[row_offset + start..row_offset + end] {
        blend_over(target, fill);
    }
}

fn flatten_subpath(subpath: &ParsedSubpath, tolerance: f64) -> Result<Vec<Point>, String> {
    let mut points = vec![subpath.start];
    let mut current = subpath.start;
    for segment in &subpath.segments {
        match segment {
            ParsedSegment::Line { to } => points.push(*to),
            ParsedSegment::Cubic {
                control_1,
                control_2,
                to,
            } => {
                append_flattened_cubic(&mut points, current, *control_1, *control_2, *to, tolerance)
            }
        }
        current = match segment {
            ParsedSegment::Line { to } | ParsedSegment::Cubic { to, .. } => *to,
        };
    }
    if points
        .iter()
        .any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        return Err("Path SVG chứa tọa độ không hữu hạn".to_string());
    }
    Ok(points)
}

fn append_flattened_cubic(
    points: &mut Vec<Point>,
    start: Point,
    control_1: Point,
    control_2: Point,
    end: Point,
    tolerance: f64,
) {
    let mut stack = vec![(start, control_1, control_2, end)];
    while let Some((start, control_1, control_2, end)) = stack.pop() {
        let flatness = point_segment_distance(control_1, start, end)
            .max(point_segment_distance(control_2, start, end));
        if flatness <= tolerance {
            points.push(end);
            continue;
        }
        let first = midpoint(start, control_1);
        let second = midpoint(control_1, control_2);
        let third = midpoint(control_2, end);
        let fourth = midpoint(first, second);
        let fifth = midpoint(second, third);
        let center = midpoint(fourth, fifth);
        stack.push((center, fifth, third, end));
        stack.push((start, first, fourth, center));
    }
}

fn winding_number(point: Point, polygon: &[Point]) -> i32 {
    if polygon.len() < 3 {
        return 0;
    }
    let mut winding = 0;
    for index in 0..polygon.len() {
        let first = polygon[index];
        let second = polygon[(index + 1) % polygon.len()];
        let side = cross(first, second, point);
        if first.y <= point.y {
            if second.y > point.y && side > 0.0 {
                winding += 1;
            }
        } else if second.y <= point.y && side < 0.0 {
            winding -= 1;
        }
    }
    winding
}

fn polyline_distance(point: Point, polyline: &[Point], closed: bool) -> f64 {
    let mut best = f64::INFINITY;
    for pair in polyline.windows(2) {
        best = best.min(point_segment_distance(point, pair[0], pair[1]));
    }
    if closed && polyline.len() > 1 {
        best = best.min(point_segment_distance(
            point,
            polyline[polyline.len() - 1],
            polyline[0],
        ));
    }
    best
}

fn compare_raster(
    rendered: &[[u8; 4]],
    reference: &[u8],
    width: usize,
    height: usize,
    scale: usize,
    is_cancelled: &mut dyn FnMut() -> bool,
) -> Result<(f64, f64), String> {
    let high_width = width
        .checked_mul(scale)
        .ok_or_else(|| "Chiều rộng raster so sánh vượt giới hạn biểu diễn".to_string())?;
    let high_height = height
        .checked_mul(scale)
        .ok_or_else(|| "Chiều cao raster so sánh vượt giới hạn biểu diễn".to_string())?;
    let expected_rendered_len = high_width
        .checked_mul(high_height)
        .ok_or_else(|| "Raster so sánh vượt giới hạn biểu diễn".to_string())?;
    if rendered.len() != expected_rendered_len {
        return Err("Raster SVG không khớp kích thước so sánh".to_string());
    }
    let mut intersection = 0_u64;
    let mut union = 0_u64;
    let mut absolute_error = 0_u64;
    for y in 0..high_height {
        ensure_qc_not_cancelled(is_cancelled)?;
        for x in 0..high_width {
            let actual = rendered[y * high_width + x];
            let reference_index = ((y / scale) * width + (x / scale)) * 4;
            let expected = [
                reference[reference_index],
                reference[reference_index + 1],
                reference[reference_index + 2],
                reference[reference_index + 3],
            ];
            let actual_visible = actual[3] > 0;
            let expected_visible = expected[3] > 0;
            intersection += u64::from(actual_visible && expected_visible);
            union += u64::from(actual_visible || expected_visible);
            for channel in 0..4 {
                absolute_error += u64::from(actual[channel].abs_diff(expected[channel]));
            }
        }
    }
    let pixel_count = rendered.len() as f64;
    let iou = if union == 0 {
        1.0
    } else {
        intersection as f64 / union as f64
    };
    let mae = absolute_error as f64 / (pixel_count * 4.0 * 255.0);
    Ok((iou, mae))
}

fn blend_over(destination: &mut [u8; 4], source: [u8; 4]) {
    let source_alpha = f64::from(source[3]) / 255.0;
    let destination_alpha = f64::from(destination[3]) / 255.0;
    let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
    if output_alpha <= f64::EPSILON {
        *destination = [0, 0, 0, 0];
        return;
    }
    for channel in 0..3 {
        let value = (f64::from(source[channel]) * source_alpha
            + f64::from(destination[channel]) * destination_alpha * (1.0 - source_alpha))
            / output_alpha;
        destination[channel] = value.round().clamp(0.0, 255.0) as u8;
    }
    destination[3] = (output_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
}

fn point_segment_distance(point: Point, start: Point, end: Point) -> f64 {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let length_squared = dx * dx + dy * dy;
    if length_squared <= f64::EPSILON {
        return (point.x - start.x).hypot(point.y - start.y);
    }
    let parameter =
        (((point.x - start.x) * dx + (point.y - start.y) * dy) / length_squared).clamp(0.0, 1.0);
    (point.x - (start.x + dx * parameter)).hypot(point.y - (start.y + dy * parameter))
}

fn signed_area_twice(points: &[Point]) -> f64 {
    (0..points.len())
        .map(|index| {
            let current = points[index];
            let next = points[(index + 1) % points.len()];
            current.x * next.y - next.x * current.y
        })
        .sum()
}

fn cross(start: Point, end: Point, point: Point) -> f64 {
    (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)
}

fn midpoint(first: Point, second: Point) -> Point {
    Point {
        x: (first.x + second.x) / 2.0,
        y: (first.y + second.y) / 2.0,
    }
}

fn physical_size_matches(expected: PhysicalSizeMm, actual: PhysicalSizeMm) -> bool {
    (expected.width_mm - actual.width_mm).abs() <= 0.000_001
        && (expected.height_mm - actual.height_mm).abs() <= 0.000_001
}
