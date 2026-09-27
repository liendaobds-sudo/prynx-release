//! Integration tests cho Invalidation Manager & Spatial Index (Milestone G1.5)
//!
//! Kiem tra:
//! 1. L0 Camera Invalidation: 0 byte / 0 CPU recompile
//! 2. L1 View State Invalidation: Graph revision tang, SceneIR bat bien
//! 3. L2 Resource / Profile Invalidation: Resource caching & invalidation theo ID
//! 4. L3 Document Edit Invalidation: Bat buoc compile lai toan bo SceneIR
//! 5. Spatial Index: Hit-testing diem chuot, box selection va reading-order text extraction

use print_engine::geom::{Matrix, Rect};
use print_engine::page_program::PageProgram;
use print_engine::scene::{
    InvalidationLevel, SceneColor, SceneCommand, SceneCompiler, ScenePageBoxes,
    SceneRevisionTracker, SceneTextRun, SpatialIndex,
};

#[test]
fn test_l0_camera_invalidation_does_not_recompile_scene() {
    let mut tracker = SceneRevisionTracker::new(1);
    assert_eq!(tracker.compile_count(), 0);

    // Lan dau compile trang
    tracker.record_compile();
    assert_eq!(tracker.compile_count(), 1);
    let initial_scene_rev = tracker.scene_revision();
    let initial_graph_rev = tracker.graph_revision();

    // Mo phong nguoi dung zoom va pan lien tuc (100 thao tac camera)
    for _ in 0..100 {
        let needs_recompile = tracker.invalidate(InvalidationLevel::L0Camera);
        assert!(!needs_recompile, "L0 Camera khong bao gio duoc phep compile lai Scene");
    }

    // BAT BIEN COT LOI: compile_count va scene_revision tuyet doi khong tang
    assert_eq!(tracker.compile_count(), 1);
    assert_eq!(tracker.scene_revision(), initial_scene_rev);
    assert_eq!(tracker.graph_revision(), initial_graph_rev);
}

#[test]
fn test_l1_view_state_invalidation_updates_graph_keeps_scene() {
    let mut tracker = SceneRevisionTracker::new(1);
    tracker.record_compile();
    let scene_rev_before = tracker.scene_revision();
    let graph_rev_before = tracker.graph_revision();

    // Nguoi dung bat/tat mot lop OCG (Optional Content Group) hoac kenh bat kem
    let needs_recompile = tracker.invalidate(InvalidationLevel::L1ViewState);
    assert!(!needs_recompile, "L1 ViewState khong compile lai Scene");

    // Scene giu nguyen revision, Graph revision tang de build lai cay render
    assert_eq!(tracker.scene_revision(), scene_rev_before);
    assert!(tracker.graph_revision() > graph_rev_before);
}

#[test]
fn test_l2_resource_profile_invalidation() {
    let mut tracker = SceneRevisionTracker::new(1);
    tracker.record_compile();
    let scene_rev_before = tracker.scene_revision();
    let graph_rev_before = tracker.graph_revision();

    // Vo hieu hoa mot anh bitmap nhung trong PDF
    tracker.invalidate_resource("Image_XObject_01");
    assert!(tracker.is_resource_invalidated("Image_XObject_01"));
    assert!(!tracker.is_resource_invalidated("Image_XObject_02"));

    // Scene revision giu nguyen, Graph revision tang
    assert_eq!(tracker.scene_revision(), scene_rev_before);
    assert!(tracker.graph_revision() > graph_rev_before);

    // Sau khi re-upload len GPU thanh cong
    tracker.clear_invalidated_resource("Image_XObject_01");
    assert!(!tracker.is_resource_invalidated("Image_XObject_01"));
}

#[test]
fn test_l3_document_edit_forces_full_recompile() {
    let mut tracker = SceneRevisionTracker::new(1);
    tracker.record_compile();
    let scene_rev_before = tracker.scene_revision();
    let graph_rev_before = tracker.graph_revision();

    // Nguoi dung undo/redo hoac sua noi dung content stream
    let needs_recompile = tracker.invalidate(InvalidationLevel::L3DocumentEdit);
    assert!(needs_recompile, "L3 bat buoc phai compile lai toan bo Scene");

    assert!(tracker.scene_revision() > scene_rev_before);
    assert!(tracker.graph_revision() > graph_rev_before);
}

#[test]
fn test_spatial_index_hit_testing_and_text_extraction() {
    let content = b"0 0 100 100 re f";
    let program = PageProgram::compile(content).expect("Compile failed");
    let boxes = ScenePageBoxes::new(Rect::new(0.0, 0.0, 500.0, 500.0), Rect::new(0.0, 0.0, 500.0, 500.0));
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let mut scene = compiler.compile_from_program(&program).expect("Compile failed");

    // Bo sung 2 text runs co toa do ro rang
    scene.commands.push(SceneCommand::Text(SceneTextRun {
        id: 101,
        font_name: "Helvetica-Bold".to_string(),
        font_size: 14.0,
        text: "PrynX Prepress".to_string(),
        char_spacing: 0.0,
        word_spacing: 0.0,
        color: SceneColor::black(),
        alpha: 1.0,
        overprint: false,
        text_matrix: Matrix::IDENTITY,
        bounds: Rect::new(50.0, 200.0, 180.0, 220.0),
    }));

    scene.commands.push(SceneCommand::Text(SceneTextRun {
        id: 102,
        font_name: "Helvetica".to_string(),
        font_size: 12.0,
        text: "GPU Engine 2026".to_string(),
        char_spacing: 0.0,
        word_spacing: 0.0,
        color: SceneColor::black(),
        alpha: 1.0,
        overprint: false,
        text_matrix: Matrix::IDENTITY,
        bounds: Rect::new(50.0, 170.0, 160.0, 190.0),
    }));

    let index = SpatialIndex::build_from_scene(&scene);

    // 1. Hit test tai diem nam trong Text Run 1 (100, 210)
    let hit_id = index.hit_test_point(100.0, 210.0, 2.0);
    assert_eq!(hit_id, Some(101));

    let text_hit = index.hit_test_text(&scene, 100.0, 210.0);
    assert!(text_hit.is_some());
    assert_eq!(text_hit.unwrap().text, "PrynX Prepress");

    // 2. Hit test tai diem trong khong gian trong (400, 400)
    let empty_hit = index.hit_test_point(400.0, 400.0, 1.0);
    assert_eq!(empty_hit, None);

    // 3. Selection Rect: Quet toan bo vung text (40, 160, 200, 230)
    let selected = index.select_text_in_rect(&scene, &Rect::new(40.0, 160.0, 200.0, 230.0));
    assert_eq!(selected.len(), 2);
    // Thu tu doc: dong tren (y cao hon trong PDF) truoc dong duoi
    assert_eq!(selected[0].text, "PrynX Prepress");
    assert_eq!(selected[1].text, "GPU Engine 2026");

    // 4. Extract text toan bo
    let extracted = index.extract_text(&scene);
    assert_eq!(extracted, "PrynX Prepress GPU Engine 2026");
}
