use super::contour::{
    extract_contours, extract_silhouette_contours, GridPoint, GridRing, CONTOUR_COORDINATE_SCALE,
};
use super::preprocess::preprocess_rgba;
use super::request::LogoEngineProfile;
use super::scene::{EngineProvenance, RingRole, SceneGeometry, VectorScene, Winding};
use super::topology::{build_vector_layers, classify_contours};

fn artifact_from_rows(rows: &[&str]) -> super::scene::PreprocessArtifact {
    let width = rows[0].len();
    assert!(rows.iter().all(|row| row.len() == width));
    let mut rgba = Vec::with_capacity(width * rows.len() * 4);
    for row in rows {
        for pixel in row.bytes() {
            match pixel {
                b'#' => rgba.extend_from_slice(&[0, 0, 0, 255]),
                b'.' => rgba.extend_from_slice(&[0, 0, 0, 0]),
                _ => panic!("fixture contour chỉ nhận # hoặc ."),
            }
        }
    }
    preprocess_rgba(width, rows.len(), &rgba, LogoEngineProfile::Silhouette, &[]).unwrap()
}

fn count_roles(layers: &[super::scene::VectorLayer]) -> (usize, usize) {
    let rings = match &layers[0].geometry[0] {
        SceneGeometry::FillRegion { rings } => rings,
        _ => panic!("fixture contour phải sinh FillRegion"),
    };
    (
        rings
            .iter()
            .filter(|ring| ring.role == RingRole::Outer)
            .count(),
        rings
            .iter()
            .filter(|ring| ring.role == RingRole::Hole)
            .count(),
    )
}

#[test]
fn block_letters_keep_o_p_r_b_counters() {
    let cases = [
        ("O", vec!["#####", "#...#", "#...#", "#...#", "#####"], 1),
        ("P", vec!["#####", "#...#", "#####", "#....", "#...."], 1),
        (
            "R",
            vec!["#####.", "#...#.", "#####.", "#..##.", "#...##", "#....#"],
            1,
        ),
        ("B", vec!["#####", "#...#", "#####", "#...#", "#####"], 2),
    ];

    for (letter, rows, expected_holes) in cases {
        let artifact = artifact_from_rows(&rows);
        let layers = build_vector_layers(&artifact).unwrap();
        let (outers, holes) = count_roles(&layers);
        assert_eq!(outers, 1, "chữ {letter} phải có đúng một outer");
        assert_eq!(holes, expected_holes, "chữ {letter} sai số counter");
    }
}

#[test]
fn nested_holes_build_an_alternating_parent_tree() {
    const SIZE: usize = 9;
    let mut rows = vec![vec![b'.'; SIZE]; SIZE];
    for index in 0..SIZE {
        rows[0][index] = b'#';
        rows[SIZE - 1][index] = b'#';
        rows[index][0] = b'#';
        rows[index][SIZE - 1] = b'#';
    }
    for index in 2..=6 {
        rows[2][index] = b'#';
        rows[6][index] = b'#';
        rows[index][2] = b'#';
        rows[index][6] = b'#';
    }
    let row_strings = rows
        .iter()
        .map(|row| std::str::from_utf8(row).unwrap())
        .collect::<Vec<_>>();
    let artifact = artifact_from_rows(&row_strings);
    let contours = extract_contours(&artifact).unwrap();
    let classified = classify_contours(&contours).unwrap();
    let mut depths = classified
        .iter()
        .map(|ring| (ring.nesting_depth, ring.role, ring.parent_ring))
        .collect::<Vec<_>>();
    depths.sort_by_key(|entry| entry.0);

    assert_eq!(depths.len(), 4);
    assert_eq!(
        depths.iter().map(|entry| entry.0).collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(
        depths.iter().map(|entry| entry.1).collect::<Vec<_>>(),
        [
            RingRole::Outer,
            RingRole::Hole,
            RingRole::Outer,
            RingRole::Hole
        ]
    );
    assert!(depths[0].2.is_none());
    assert!(depths[1..].iter().all(|entry| entry.2.is_some()));
}

#[test]
fn touching_corner_stays_as_two_outer_rings() {
    let artifact = artifact_from_rows(&["#.", ".#"]);
    assert_eq!(artifact.components.len(), 2);

    let contours = extract_contours(&artifact).unwrap();
    let classified = classify_contours(&contours).unwrap();
    assert_eq!(classified.len(), 2);
    assert!(classified.iter().all(|ring| {
        ring.role == RingRole::Outer
            && ring.winding == Winding::Clockwise
            && ring.vertices.len() == 5
            && ring.saddle_cuts == 1
    }));
}

#[test]
fn checkerboard_saddle_is_resolved_per_color_label() {
    let rgba = vec![
        255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255,
    ];
    let palette = vec!["#ff0000".to_string(), "#0000ff".to_string()];
    let artifact = preprocess_rgba(2, 2, &rgba, LogoEngineProfile::FlatColor, &palette).unwrap();
    let classified = classify_contours(&extract_contours(&artifact).unwrap()).unwrap();

    assert_eq!(classified.len(), 4);
    for label in 0..=1 {
        let rings = classified
            .iter()
            .filter(|ring| ring.label_index == label)
            .collect::<Vec<_>>();
        assert_eq!(rings.len(), 2);
        assert!(rings.iter().all(|ring| ring.role == RingRole::Outer));
    }
    assert_eq!(build_vector_layers(&artifact).unwrap().len(), 2);
}

#[test]
fn diagonal_background_channel_does_not_become_a_false_hole() {
    let artifact = artifact_from_rows(&["###", "#.#", "##."]);
    let layers = build_vector_layers(&artifact).unwrap();

    assert_eq!(count_roles(&layers), (1, 0));
}

#[test]
fn long_edges_at_saddle_keep_a_fixed_half_pixel_chamfer() {
    let artifact = artifact_from_rows(&["#####", "#.###", "##..."]);
    let layers = build_vector_layers(&artifact).unwrap();

    assert_eq!(count_roles(&layers), (1, 0));
}

#[test]
fn bow_tie_self_intersection_is_rejected() {
    let contour = GridRing {
        label_index: 0,
        vertices: vec![
            GridPoint { x2: 0, y2: 0 },
            GridPoint { x2: 4, y2: 4 },
            GridPoint { x2: 0, y2: 4 },
            GridPoint { x2: 4, y2: 0 },
        ],
        saddle_cuts: 0,
    };

    assert!(classify_contours(&[contour])
        .unwrap_err()
        .contains("tự cắt"));
}

#[test]
fn all_transparent_input_stops_before_contour() {
    let error = preprocess_rgba(2, 2, &[0; 16], LogoEngineProfile::Silhouette, &[]).unwrap_err();

    assert!(error.contains("không có pixel hiển thị"));
}

#[test]
fn contour_signed_area_matches_raster_pixel_count() {
    let artifact =
        artifact_from_rows(&["######", "#....#", "#.##.#", "#.##.#", "#....#", "######"]);
    let classified = classify_contours(&extract_contours(&artifact).unwrap()).unwrap();
    let signed_area_twice = classified
        .iter()
        .map(|ring| ring.signed_area_twice)
        .sum::<i128>();
    let saddle_cuts = classified
        .iter()
        .map(|ring| i128::from(ring.saddle_cuts))
        .sum::<i128>();

    let saddle_area_twice = saddle_cuts * i128::from(CONTOUR_COORDINATE_SCALE).pow(2) / 4;
    assert_eq!(
        signed_area_twice + saddle_area_twice,
        i128::from(artifact.visible_pixel_count())
            * 2
            * i128::from(CONTOUR_COORDINATE_SCALE).pow(2)
    );
    assert!(build_vector_layers(&artifact).is_ok());
}

#[test]
fn antialiased_silhouette_uses_interpolated_subpixel_isoline() {
    // LOGO-TRAJECTORY (audit 2026-08-25 F-01): alpha coverage phải dịch
    // quỹ đạo theo iso-line, không bị lượng tử lại thành cạnh ô pixel.
    let alphas = [0_u8, 64, 0, 64, 255, 64, 0, 64, 0];
    let rgba = alphas
        .into_iter()
        .flat_map(|alpha| [0, 0, 0, alpha])
        .collect::<Vec<_>>();
    let artifact = preprocess_rgba(3, 3, &rgba, LogoEngineProfile::Silhouette, &[]).unwrap();

    let first = extract_silhouette_contours(&artifact).unwrap();
    let second = extract_silhouette_contours(&artifact).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.len(), 1);
    let half = CONTOUR_COORDINATE_SCALE / 2;
    assert!(first[0].vertices.iter().any(|point| {
        let x = point.x2.rem_euclid(CONTOUR_COORDINATE_SCALE);
        let y = point.y2.rem_euclid(CONTOUR_COORDINATE_SCALE);
        (x != 0 && x != half) || (y != 0 && y != half)
    }));
}
#[test]
fn antialiased_nested_isolines_normalize_outer_and_hole_winding() {
    // [LOGO-TRAJECTORY FIX 2026-08-25] Hướng stitch cục bộ có thể đảo tại
    // điểm lượng tử hóa; parity containment mới là nguồn sự thật của winding.
    const SIZE: usize = 24;
    const OUTER_RADIUS: f64 = 8.0;
    const INNER_RADIUS: f64 = 3.0;
    let mut rgba = Vec::with_capacity(SIZE * SIZE * 4);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let distance =
                (x as f64 + 0.5 - SIZE as f64 * 0.5).hypot(y as f64 + 0.5 - SIZE as f64 * 0.5);
            let outer_coverage = (OUTER_RADIUS + 0.5 - distance).clamp(0.0, 1.0);
            let hole_coverage = (distance - (INNER_RADIUS - 0.5)).clamp(0.0, 1.0);
            let alpha = (outer_coverage.min(hole_coverage) * 255.0).round() as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    let artifact = preprocess_rgba(SIZE, SIZE, &rgba, LogoEngineProfile::Silhouette, &[]).unwrap();
    let classified = classify_contours(&extract_silhouette_contours(&artifact).unwrap()).unwrap();

    assert_eq!(classified.len(), 2);
    assert!(classified
        .iter()
        .any(|ring| { ring.role == RingRole::Outer && ring.winding == Winding::Clockwise }));
    assert!(classified
        .iter()
        .any(|ring| { ring.role == RingRole::Hole && ring.winding == Winding::CounterClockwise }));
    assert!(classified
        .iter()
        .all(|ring| { (ring.role == RingRole::Outer) == (ring.signed_area_twice > 0) }));
}

#[test]
fn single_pixel_uses_pixel_extent_and_four_corners() {
    let artifact = artifact_from_rows(&["#"]);
    let contours = extract_contours(&artifact).unwrap();

    assert_eq!(contours.len(), 1);
    assert_eq!(
        contours[0].vertices,
        [
            GridPoint { x2: 0, y2: 0 },
            GridPoint {
                x2: CONTOUR_COORDINATE_SCALE,
                y2: 0,
            },
            GridPoint {
                x2: CONTOUR_COORDINATE_SCALE,
                y2: CONTOUR_COORDINATE_SCALE,
            },
            GridPoint {
                x2: 0,
                y2: CONTOUR_COORDINATE_SCALE,
            },
        ]
    );
}

#[test]
fn contour_output_is_deterministic() {
    let artifact = artifact_from_rows(&["##..#", "##..#", "..###", ".#..."]);

    assert_eq!(
        extract_contours(&artifact).unwrap(),
        extract_contours(&artifact).unwrap()
    );
}

#[test]
fn scene_contract_rejects_outer_with_counterclockwise_winding() {
    let artifact = artifact_from_rows(&["###", "#.#", "###"]);
    let mut scene = VectorScene::empty(
        artifact.width_px,
        artifact.height_px,
        EngineProvenance {
            engine: "test".to_string(),
            engine_version: "1".to_string(),
            profile: "silhouette".to_string(),
            settings_hash: "abc".to_string(),
        },
    );
    scene.layers = build_vector_layers(&artifact).unwrap();
    assert!(scene.validate_contract().is_ok());

    let SceneGeometry::FillRegion { rings } = &mut scene.layers[0].geometry[0] else {
        panic!("fixture contour phải sinh FillRegion");
    };
    rings[0].winding = Winding::CounterClockwise;
    assert!(scene
        .validate_contract()
        .unwrap_err()
        .contains("không khớp"));
}
