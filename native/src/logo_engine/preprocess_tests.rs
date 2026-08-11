use super::color::{delta_e_2000, LabColor};
use super::preprocess::preprocess_rgba;
use super::request::LogoEngineProfile;
use super::scene::TRANSPARENT_PIXEL_LABEL;

fn palette(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn solid_rgba(width: usize, height: usize, color: [u8; 4]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(width * height * 4);
    for _ in 0..width * height {
        rgba.extend_from_slice(&color);
    }
    rgba
}

fn set_pixel(rgba: &mut [u8], width: usize, x: usize, y: usize, color: [u8; 4]) {
    let offset = (y * width + x) * 4;
    rgba[offset..offset + 4].copy_from_slice(&color);
}

#[test]
fn transparent_rgb_does_not_enter_palette_map() {
    let rgba = vec![255, 0, 0, 0, 0, 0, 255, 255];
    let artifact = preprocess_rgba(
        2,
        1,
        &rgba,
        LogoEngineProfile::FlatColor,
        &palette(&["#ff0000", "#0000ff"]),
    )
    .unwrap();

    assert_eq!(artifact.alpha_mask, [0, 255]);
    assert_eq!(artifact.labels, [TRANSPARENT_PIXEL_LABEL, 1]);
    assert_eq!(artifact.label_pixel_counts, [0, 1]);
    assert_eq!(artifact.visible_pixel_count(), 1);
}

#[test]
fn hidden_rgb_below_zero_alpha_does_not_change_artifact_hash() {
    let first = vec![255, 0, 0, 0, 0, 0, 255, 255];
    let second = vec![0, 255, 0, 0, 0, 0, 255, 255];
    let confirmed_palette = palette(&["#ff0000", "#0000ff"]);

    let first_artifact = preprocess_rgba(
        2,
        1,
        &first,
        LogoEngineProfile::FlatColor,
        &confirmed_palette,
    )
    .unwrap();
    let second_artifact = preprocess_rgba(
        2,
        1,
        &second,
        LogoEngineProfile::FlatColor,
        &confirmed_palette,
    )
    .unwrap();

    assert_eq!(first_artifact, second_artifact);
    assert_eq!(first_artifact.artifact_hash.len(), 64);
}

#[test]
fn alpha_coverage_is_preserved_and_participates_in_hash() {
    let first = vec![0, 0, 0, 1, 0, 0, 0, 255];
    let second = vec![0, 0, 0, 2, 0, 0, 0, 255];

    let first_artifact = preprocess_rgba(2, 1, &first, LogoEngineProfile::Silhouette, &[]).unwrap();
    let second_artifact =
        preprocess_rgba(2, 1, &second, LogoEngineProfile::Silhouette, &[]).unwrap();

    assert_eq!(first_artifact.alpha_mask, [1, 255]);
    assert_eq!(first_artifact.labels, [0, 0]);
    assert_ne!(first_artifact.artifact_hash, second_artifact.artifact_hash);
}

#[test]
fn delta_e_2000_matches_published_reference_pair() {
    let first = LabColor {
        l: 50.0,
        a: 2.6772,
        b: -79.7751,
    };
    let second = LabColor {
        l: 50.0,
        a: 0.0,
        b: -82.7485,
    };

    assert!((delta_e_2000(first, second) - 2.0425).abs() < 0.0001);
}

#[test]
fn palette_mapping_uses_perceptual_distance_instead_of_rgb_tie() {
    let artifact = preprocess_rgba(
        1,
        1,
        &[128, 128, 0, 255],
        LogoEngineProfile::FlatColor,
        &palette(&["#ff0000", "#00ff00"]),
    )
    .unwrap();

    // Olive cách đỏ và xanh lá bằng nhau trong RGB Euclid; CIEDE2000 chọn xanh lá.
    assert_eq!(artifact.labels, [1]);
}

#[test]
fn connected_accent_below_one_percent_is_kept() {
    const WIDTH: usize = 32;
    const HEIGHT: usize = 32;
    let mut rgba = solid_rgba(WIDTH, HEIGHT, [0, 0, 255, 255]);
    for y in 10..12 {
        for x in 10..12 {
            set_pixel(&mut rgba, WIDTH, x, y, [255, 0, 0, 255]);
        }
    }

    let artifact = preprocess_rgba(
        WIDTH,
        HEIGHT,
        &rgba,
        LogoEngineProfile::FlatColor,
        &palette(&["#0000ff", "#ff0000"]),
    )
    .unwrap();
    let accent_components = artifact.components_for_label(1).collect::<Vec<_>>();

    assert!(4.0 / f64::from((WIDTH * HEIGHT) as u32) < 0.01);
    assert_eq!(artifact.label_pixel_counts, [1020, 4]);
    assert_eq!(accent_components.len(), 1);
    assert_eq!(accent_components[0].pixel_count, 4);
    assert_eq!(
        (
            accent_components[0].min_x,
            accent_components[0].min_y,
            accent_components[0].max_x,
            accent_components[0].max_y,
        ),
        (10, 10, 11, 11)
    );
}

#[test]
fn every_visible_pixel_has_exactly_one_label() {
    let rgba = vec![255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 8, 7, 0];
    let artifact = preprocess_rgba(
        2,
        2,
        &rgba,
        LogoEngineProfile::FlatColor,
        &palette(&["#ff0000", "#00ff00", "#0000ff"]),
    )
    .unwrap();

    assert_eq!(artifact.visible_pixel_count(), 3);
    assert_eq!(artifact.label_pixel_counts.iter().sum::<u64>(), 3);
    assert_eq!(artifact.labels[3], TRANSPARENT_PIXEL_LABEL);
    assert!(artifact.validate_contract().is_ok());
}

#[test]
fn contract_rejects_a_visible_pixel_without_palette_label() {
    let mut artifact = preprocess_rgba(
        1,
        1,
        &[255, 0, 0, 255],
        LogoEngineProfile::FlatColor,
        &palette(&["#ff0000"]),
    )
    .unwrap();
    artifact.labels[0] = TRANSPARENT_PIXEL_LABEL;

    assert!(artifact
        .validate_contract()
        .unwrap_err()
        .contains("đúng một nhãn"));
}

#[test]
fn all_transparent_image_is_rejected() {
    let error = preprocess_rgba(
        2,
        2,
        &solid_rgba(2, 2, [255, 0, 0, 0]),
        LogoEngineProfile::FlatColor,
        &palette(&["#ff0000"]),
    )
    .unwrap_err();

    assert!(error.contains("không có pixel hiển thị"));
}

#[test]
fn malformed_palette_color_is_rejected() {
    let error = preprocess_rgba(
        1,
        1,
        &[255, 0, 0, 255],
        LogoEngineProfile::FlatColor,
        &palette(&["red"]),
    )
    .unwrap_err();

    assert!(error.contains("#RRGGBB"));
}
