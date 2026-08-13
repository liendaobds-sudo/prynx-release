//! Tiền xử lý raster thành alpha mask và bản đồ nhãn màu xác định.

#![allow(dead_code)]

use super::color::{nearest_palette_index, parse_palette, PaletteColor};
use super::request::LogoEngineProfile;
use super::scene::{
    PreprocessArtifact, RasterColorComponent, SolidPaint, PREPROCESS_ARTIFACT_VERSION,
    TRANSPARENT_PIXEL_LABEL,
};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;

pub(crate) fn preprocess_rgba(
    width: usize,
    height: usize,
    rgba: &[u8],
    profile: LogoEngineProfile,
    palette: &[String],
) -> Result<PreprocessArtifact, String> {
    let pixel_count = width
        .checked_mul(height)
        .ok_or_else(|| "Kích thước ảnh logo vượt giới hạn biểu diễn".to_string())?;
    let expected_bytes = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "Kích thước ảnh logo vượt giới hạn biểu diễn".to_string())?;
    if width == 0 || height == 0 {
        return Err("Ảnh logo phải có kích thước lớn hơn 0".to_string());
    }
    if rgba.len() != expected_bytes {
        return Err(format!(
            "Buffer RGBA không khớp kích thước: cần {expected_bytes} byte, nhận {} byte",
            rgba.len()
        ));
    }
    let width_px = u32::try_from(width)
        .map_err(|_| "Chiều rộng ảnh logo vượt giới hạn biểu diễn".to_string())?;
    let height_px = u32::try_from(height)
        .map_err(|_| "Chiều cao ảnh logo vượt giới hạn biểu diễn".to_string())?;

    // LOGO-ENGINE-V2 (audit 2026-08-10 Lô B): không lọc theo diện tích;
    // màu nhấn nhỏ do người dùng xác nhận vẫn giữ nguyên nhãn và component.
    let palette_colors = build_palette(profile, palette)?;
    if palette_colors.len() > usize::from(TRANSPARENT_PIXEL_LABEL) {
        return Err("Palette vượt khả năng biểu diễn nhãn màu".to_string());
    }

    let mut alpha_mask = Vec::with_capacity(pixel_count);
    let mut labels = Vec::with_capacity(pixel_count);
    let mut label_pixel_counts = vec![0_u64; palette_colors.len()];

    for pixel in rgba.chunks_exact(4) {
        let alpha = pixel[3];
        alpha_mask.push(alpha);
        if alpha == 0 {
            labels.push(TRANSPARENT_PIXEL_LABEL);
            continue;
        }

        let label_index = match profile {
            LogoEngineProfile::Silhouette => 0,
            LogoEngineProfile::FlatColor => {
                nearest_palette_index([pixel[0], pixel[1], pixel[2]], &palette_colors)
            }
        };
        labels.push(label_index as u16);
        label_pixel_counts[label_index] += 1;
    }

    if label_pixel_counts.iter().sum::<u64>() == 0 {
        return Err("Ảnh không có pixel hiển thị để vector hóa".to_string());
    }

    let components = collect_components(&labels, width, height);
    let palette = palette_colors
        .iter()
        .map(|entry| entry.paint)
        .collect::<Vec<_>>();
    let artifact_hash = hash_artifact(width_px, height_px, profile, &palette, &alpha_mask, &labels);
    let artifact = PreprocessArtifact {
        version: PREPROCESS_ARTIFACT_VERSION,
        width_px,
        height_px,
        palette,
        alpha_mask,
        labels,
        label_pixel_counts,
        components,
        artifact_hash,
    };
    artifact.validate_contract()?;
    Ok(artifact)
}

/// Loại component nhỏ hơn bình phương kích thước khử hạt bằng cách nhập chúng
/// vào màu bao quanh chiếm ưu thế. Cách làm này giữ nguyên độ phân giải nguồn;
/// tham số chỉ quyết định vùng nhiễu nào bị loại, không phải quality cap.
pub(crate) fn despeckle_artifact(
    artifact: &mut PreprocessArtifact,
    profile: LogoEngineProfile,
    despeckle_size_px: usize,
) -> Result<usize, String> {
    if despeckle_size_px == 0 {
        return Ok(0);
    }
    artifact.validate_contract()?;
    let minimum_area = despeckle_size_px
        .checked_mul(despeckle_size_px)
        .ok_or_else(|| "Kích thước khử hạt vượt giới hạn biểu diễn".to_string())?;
    let width = artifact.width_px as usize;
    let height = artifact.height_px as usize;
    let mut components = collect_component_pixels(&artifact.labels, width, height);
    // LOGO-ENGINE-V2 (audit 2026-08-12 Hotfix H2): xử lý vùng nhỏ trước để
    // chúng nhập vào vùng lớn ổn định, không đổi kết quả theo thứ tự palette.
    components.sort_by_key(|component| (component.pixels.len(), component.first_pixel));

    let mut removed_components = 0;
    for component in components {
        if component.pixels.len() >= minimum_area {
            continue;
        }
        let Some(replacement) = dominant_neighbor_label(
            &artifact.labels,
            &component.pixels,
            component.label,
            width,
            height,
        ) else {
            continue;
        };
        for &index in &component.pixels {
            artifact.labels[index] = replacement;
            if replacement == TRANSPARENT_PIXEL_LABEL {
                artifact.alpha_mask[index] = 0;
            }
        }
        removed_components += 1;
    }

    artifact.label_pixel_counts.fill(0);
    for (&alpha, &label) in artifact.alpha_mask.iter().zip(&artifact.labels) {
        if alpha == 0 || label == TRANSPARENT_PIXEL_LABEL {
            continue;
        }
        let count = artifact
            .label_pixel_counts
            .get_mut(usize::from(label))
            .ok_or_else(|| "Khử hạt sinh nhãn màu ngoài palette".to_string())?;
        *count += 1;
    }
    if artifact.label_pixel_counts.iter().sum::<u64>() == 0 {
        return Err("Khử hạt đã loại toàn bộ vùng logo hiển thị".to_string());
    }
    artifact.components = collect_components(&artifact.labels, width, height);
    artifact.artifact_hash = hash_artifact(
        artifact.width_px,
        artifact.height_px,
        profile,
        &artifact.palette,
        &artifact.alpha_mask,
        &artifact.labels,
    );
    artifact.validate_contract()?;
    Ok(removed_components)
}

#[derive(Debug)]
struct ComponentPixels {
    label: u16,
    first_pixel: usize,
    pixels: Vec<usize>,
}

fn collect_component_pixels(labels: &[u16], width: usize, height: usize) -> Vec<ComponentPixels> {
    let mut visited = vec![false; labels.len()];
    let mut components = Vec::new();
    let mut queue = VecDeque::new();

    for start in 0..labels.len() {
        let label = labels[start];
        if label == TRANSPARENT_PIXEL_LABEL || visited[start] {
            continue;
        }
        visited[start] = true;
        queue.push_back(start);
        let mut pixels = Vec::new();
        while let Some(index) = queue.pop_front() {
            pixels.push(index);
            let x = index % width;
            let y = index / width;
            if x > 0 {
                enqueue_same_label(index - 1, label, labels, &mut visited, &mut queue);
            }
            if x + 1 < width {
                enqueue_same_label(index + 1, label, labels, &mut visited, &mut queue);
            }
            if y > 0 {
                enqueue_same_label(index - width, label, labels, &mut visited, &mut queue);
            }
            if y + 1 < height {
                enqueue_same_label(index + width, label, labels, &mut visited, &mut queue);
            }
        }
        components.push(ComponentPixels {
            label,
            first_pixel: start,
            pixels,
        });
    }
    components
}

fn dominant_neighbor_label(
    labels: &[u16],
    pixels: &[usize],
    own_label: u16,
    width: usize,
    height: usize,
) -> Option<u16> {
    let mut boundary_counts = std::collections::BTreeMap::<u16, usize>::new();
    for &index in pixels {
        let x = index % width;
        let y = index / width;
        let mut visit = |neighbor: usize| {
            let label = labels[neighbor];
            if label != own_label {
                *boundary_counts.entry(label).or_default() += 1;
            }
        };
        if x > 0 {
            visit(index - 1);
        }
        if x + 1 < width {
            visit(index + 1);
        }
        if y > 0 {
            visit(index - width);
        }
        if y + 1 < height {
            visit(index + width);
        }
    }
    boundary_counts
        .into_iter()
        .max_by_key(|(label, count)| {
            (
                *count,
                usize::from(*label == TRANSPARENT_PIXEL_LABEL),
                std::cmp::Reverse(*label),
            )
        })
        .map(|(label, _)| label)
}

fn build_palette(
    profile: LogoEngineProfile,
    palette: &[String],
) -> Result<Vec<PaletteColor>, String> {
    match profile {
        LogoEngineProfile::Silhouette => {
            if !palette.is_empty() {
                return Err("Chế độ đen trắng không nhận palette màu".to_string());
            }
            parse_palette(&["#000000".to_string()])
        }
        LogoEngineProfile::FlatColor => {
            if palette.is_empty() {
                return Err("Chế độ màu cần ít nhất một màu đã xác nhận".to_string());
            }
            parse_palette(palette)
        }
    }
}

fn collect_components(labels: &[u16], width: usize, height: usize) -> Vec<RasterColorComponent> {
    let mut visited = vec![false; labels.len()];
    let mut components = Vec::new();
    let mut queue = VecDeque::new();

    for start in 0..labels.len() {
        let label = labels[start];
        if label == TRANSPARENT_PIXEL_LABEL || visited[start] {
            continue;
        }

        visited[start] = true;
        queue.push_back(start);
        let mut pixel_count = 0_u64;
        let mut min_x = u32::MAX;
        let mut min_y = u32::MAX;
        let mut max_x = 0_u32;
        let mut max_y = 0_u32;

        while let Some(index) = queue.pop_front() {
            let x = index % width;
            let y = index / width;
            pixel_count += 1;
            min_x = min_x.min(x as u32);
            min_y = min_y.min(y as u32);
            max_x = max_x.max(x as u32);
            max_y = max_y.max(y as u32);

            if x > 0 {
                enqueue_same_label(index - 1, label, labels, &mut visited, &mut queue);
            }
            if x + 1 < width {
                enqueue_same_label(index + 1, label, labels, &mut visited, &mut queue);
            }
            if y > 0 {
                enqueue_same_label(index - width, label, labels, &mut visited, &mut queue);
            }
            if y + 1 < height {
                enqueue_same_label(index + width, label, labels, &mut visited, &mut queue);
            }
        }

        components.push(RasterColorComponent {
            label_index: label,
            pixel_count,
            min_x,
            min_y,
            max_x,
            max_y,
        });
    }

    components
}

fn enqueue_same_label(
    index: usize,
    label: u16,
    labels: &[u16],
    visited: &mut [bool],
    queue: &mut VecDeque<usize>,
) {
    if !visited[index] && labels[index] == label {
        visited[index] = true;
        queue.push_back(index);
    }
}

fn hash_artifact(
    width_px: u32,
    height_px: u32,
    profile: LogoEngineProfile,
    palette: &[SolidPaint],
    alpha_mask: &[u8],
    labels: &[u16],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PREPROCESS_ARTIFACT_VERSION.to_be_bytes());
    hasher.update(width_px.to_be_bytes());
    hasher.update(height_px.to_be_bytes());
    hasher.update(profile.as_str().as_bytes());
    hasher.update((palette.len() as u32).to_be_bytes());
    for paint in palette {
        hasher.update(paint.rgba);
    }
    hasher.update(alpha_mask);
    for label in labels {
        hasher.update(label.to_be_bytes());
    }
    format!("{:x}", hasher.finalize())
}
