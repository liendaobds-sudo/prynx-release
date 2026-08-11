use super::contour::{extract_contours, GridPoint, GridRing, CONTOUR_COORDINATE_SCALE};
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

    assert_eq!(
        signed_area_twice + saddle_cuts,
        i128::from(artifact.visible_pixel_count())
            * 2
            * i128::from(CONTOUR_COORDINATE_SCALE).pow(2)
    );
    assert!(build_vector_layers(&artifact).is_ok());
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
            GridPoint { x2: 2, y2: 0 },
            GridPoint { x2: 2, y2: 2 },
            GridPoint { x2: 0, y2: 2 },
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
