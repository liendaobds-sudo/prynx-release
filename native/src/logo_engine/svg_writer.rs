//! SVG writer xác định cho VectorScene của PrynX Logo Engine v2.

#![allow(dead_code)]

use super::scene::{SceneGeometry, ScenePath, SceneSegment, SolidPaint, VectorScene};
use sha2::{Digest, Sha256};
use std::fmt::Write;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PhysicalSizeMm {
    pub(crate) width_mm: f64,
    pub(crate) height_mm: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct SvgWriteOptions {
    pub(crate) physical_size_mm: Option<PhysicalSizeMm>,
    /// Ngân sách do caller/scheduler truyền vào; None không hard-cap máy mạnh.
    pub(crate) max_output_bytes: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SvgArtifact {
    pub(crate) svg: String,
    pub(crate) sha256: String,
    pub(crate) byte_len: usize,
}

pub(crate) fn write_svg(
    scene: &VectorScene,
    options: SvgWriteOptions,
) -> Result<SvgArtifact, String> {
    scene.validate_contract()?;
    if scene.layers.is_empty() || scene.layers.iter().all(|layer| layer.geometry.is_empty()) {
        return Err("VectorScene rỗng không thể ghi SVG".to_string());
    }
    if let Some(physical) = options.physical_size_mm {
        validate_physical_size(scene, physical)?;
    }

    let mut svg = String::new();
    write!(
        svg,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\"",
        scene.width_px, scene.height_px
    )
    .map_err(|_| "Không dựng được thẻ SVG gốc".to_string())?;
    match options.physical_size_mm {
        Some(physical) => write!(
            svg,
            " width=\"{}mm\" height=\"{}mm\"",
            format_number(physical.width_mm),
            format_number(physical.height_mm)
        ),
        None => write!(
            svg,
            " width=\"{}\" height=\"{}\"",
            scene.width_px, scene.height_px
        ),
    }
    .map_err(|_| "Không ghi được kích thước SVG".to_string())?;
    write!(
        svg,
        " shape-rendering=\"geometricPrecision\" data-prynx-scene-version=\"{}\" data-prynx-engine=\"{}\" data-prynx-engine-version=\"{}\" data-prynx-profile=\"{}\" data-prynx-settings=\"{}\">\n",
        scene.version,
        escape_xml_attribute(&scene.provenance.engine),
        escape_xml_attribute(&scene.provenance.engine_version),
        escape_xml_attribute(&scene.provenance.profile),
        escape_xml_attribute(&scene.provenance.settings_hash),
    )
    .map_err(|_| "Không ghi được provenance SVG".to_string())?;

    for (layer_index, layer) in scene.layers.iter().enumerate() {
        for (geometry_index, geometry) in layer.geometry.iter().enumerate() {
            match geometry {
                SceneGeometry::FillRegion { rings } => {
                    let mut path_data = String::new();
                    for ring in rings {
                        append_path_data(&mut path_data, &ring.path)?;
                    }
                    write!(
                        svg,
                        "  <path data-prynx-layer=\"{layer_index}\" data-prynx-geometry=\"{geometry_index}\" fill=\"{}\"{} fill-rule=\"nonzero\" d=\"{}\"/>\n",
                        paint_hex(layer.paint),
                        opacity_attribute("fill", layer.paint),
                        path_data.trim(),
                    )
                    .map_err(|_| "Không ghi được vùng tô SVG".to_string())?;
                }
                SceneGeometry::StrokePath { path, width_px } => {
                    let mut path_data = String::new();
                    append_path_data(&mut path_data, path)?;
                    write!(
                        svg,
                        "  <path data-prynx-layer=\"{layer_index}\" data-prynx-geometry=\"{geometry_index}\" fill=\"none\" stroke=\"{}\"{} stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"{}\"/>\n",
                        paint_hex(layer.paint),
                        opacity_attribute("stroke", layer.paint),
                        format_number(*width_px),
                        path_data.trim(),
                    )
                    .map_err(|_| "Không ghi được nét SVG".to_string())?;
                }
            }
        }
    }
    svg.push_str("</svg>\n");

    if options
        .max_output_bytes
        .is_some_and(|budget| svg.len() > budget)
    {
        return Err(format!("SVG vượt ngân sách caller: {} byte", svg.len()));
    }
    let sha256 = format!("{:x}", Sha256::digest(svg.as_bytes()));
    let byte_len = svg.len();
    Ok(SvgArtifact {
        svg,
        sha256,
        byte_len,
    })
}

fn append_path_data(output: &mut String, path: &ScenePath) -> Result<(), String> {
    write!(
        output,
        "M {} {} ",
        format_number(path.start.x),
        format_number(path.start.y)
    )
    .map_err(|_| "Không ghi được điểm đầu path".to_string())?;
    for segment in &path.segments {
        match segment {
            SceneSegment::Line { to } => {
                write!(output, "L {} {} ", format_number(to.x), format_number(to.y))
            }
            SceneSegment::Cubic {
                control_1,
                control_2,
                to,
            } => write!(
                output,
                "C {} {} {} {} {} {} ",
                format_number(control_1.x),
                format_number(control_1.y),
                format_number(control_2.x),
                format_number(control_2.y),
                format_number(to.x),
                format_number(to.y)
            ),
        }
        .map_err(|_| "Không ghi được segment SVG".to_string())?;
    }
    if path.closed {
        output.push_str("Z ");
    }
    Ok(())
}

fn validate_physical_size(scene: &VectorScene, physical: PhysicalSizeMm) -> Result<(), String> {
    if !physical.width_mm.is_finite()
        || !physical.height_mm.is_finite()
        || physical.width_mm <= 0.0
        || physical.height_mm <= 0.0
    {
        return Err("Kích thước vật lý phải là cặp mm hữu hạn lớn hơn 0".to_string());
    }
    let pixel_ratio = f64::from(scene.width_px) / f64::from(scene.height_px);
    let physical_ratio = physical.width_mm / physical.height_mm;
    let relative_error = ((physical_ratio / pixel_ratio) - 1.0).abs();
    if relative_error > 0.000_1 {
        return Err("Tỷ lệ kích thước mm không khớp canvas pixel".to_string());
    }
    Ok(())
}

fn paint_hex(paint: SolidPaint) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        paint.rgba[0], paint.rgba[1], paint.rgba[2]
    )
}

fn opacity_attribute(kind: &str, paint: SolidPaint) -> String {
    if paint.rgba[3] == 255 {
        String::new()
    } else {
        format!(
            " {kind}-opacity=\"{}\"",
            format_number(f64::from(paint.rgba[3]) / 255.0)
        )
    }
}

fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    let mut formatted = format!("{value:.6}");
    while formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    formatted
}

fn escape_xml_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
