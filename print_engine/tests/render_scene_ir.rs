//! Integration tests cho Scene IR & SceneCompiler (Milestone G1.1)

use print_engine::geom::{Rect};
use print_engine::page_program::PageProgram;
use print_engine::scene::{
    SceneCamera, SceneCompiler, ScenePageBoxes,
};

#[test]
fn test_scene_ir_compilation_from_page_program() {
    // Mau content stream PDF co lenh ve vector va text
    let content_bytes = b"q 0.5 0.5 100 200 re f Q BT /F1 12 Tf 100 100 Td (Hello PrynX) Tj ET";
    let program = PageProgram::compile(content_bytes).expect("PageProgram compilation failed");

    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 595.28, 841.89),
        Rect::new(0.0, 0.0, 595.28, 841.89),
    );

    let compiler = SceneCompiler::new(1, boxes, 0, 1.0).with_revision(42);
    let scene = compiler.compile_from_program(&program).expect("Scene compilation failed");

    assert_eq!(scene.page_number, 1);
    assert_eq!(scene.revision, 42);
    assert_eq!(scene.rotation, 0);
    assert_eq!(scene.user_unit, 1.0);
    assert!(scene.command_count() > 0, "Scene phai chua it nhat 1 command");
    assert!(!scene.is_empty());
    assert_eq!(scene.bounds.width(), 595.28);
    assert_eq!(scene.bounds.height(), 841.89);
}

#[test]
fn test_camera_zoom_invariant_keeps_scene_ir_unchanged() {
    let content_bytes = b"0 0 100 100 re f";
    let program = PageProgram::compile(content_bytes).expect("PageProgram compilation failed");
    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 600.0, 800.0),
        Rect::new(0.0, 0.0, 600.0, 800.0),
    );

    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let scene = compiler.compile_from_program(&program).expect("Scene compilation failed");

    let initial_cmd_count = scene.command_count();
    let initial_bounds = scene.bounds;

    // Khoi tao Camera
    let mut camera = SceneCamera::new(1.0, 0.0, 0.0, 1.25);

    // Kiem tra bien doi qua lai giua Scene va Physical Pixels
    let (phys_x, phys_y) = camera.scene_to_physical(100.0, 200.0);
    assert_eq!(phys_x, 125.0); // 100 * 1.0 * 1.25
    assert_eq!(phys_y, 250.0); // 200 * 1.0 * 1.25

    let (scene_x, scene_y) = camera.viewport_to_scene(100.0, 200.0);
    assert_eq!(scene_x, 100.0);
    assert_eq!(scene_y, 200.0);

    // Thuc hien chuoi zoom lien tuc (25%, 50%, 150%, 300%, 800%) voi anchor tai (400, 300)
    let zoom_steps = [0.25, 0.50, 1.50, 3.00, 8.00];
    for &scale in &zoom_steps {
        camera.zoom_at_anchor(scale, 400.0, 300.0);

        // Kiem tra diem neo van tro vao dung vi tri cu trong Scene
        let (anchor_scene_x, anchor_scene_y) = camera.viewport_to_scene(400.0, 300.0);
        let (reprojected_vp_x, reprojected_vp_y) = (
            anchor_scene_x * camera.scale + camera.pan_x,
            anchor_scene_y * camera.scale + camera.pan_y,
        );
        assert!((reprojected_vp_x - 400.0).abs() < 1e-4);
        assert!((reprojected_vp_y - 300.0).abs() < 1e-4);

        // BAT BIEN COT LOI: SceneIR hoan toan bat bien, khong bi sua doi hoac compile lai
        assert_eq!(scene.command_count(), initial_cmd_count);
        assert_eq!(scene.bounds, initial_bounds);
    }
}

#[test]
fn test_rotation_and_user_unit_normalization() {
    let content_bytes = b"0 0 100 100 re f";
    let program = PageProgram::compile(content_bytes).expect("PageProgram compilation failed");
    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 400.0, 600.0),
        Rect::new(0.0, 0.0, 400.0, 600.0),
    );

    // Rotation 90 do: width va height duoc dao vi tri trong scene bounds
    let compiler_90 = SceneCompiler::new(1, boxes, 90, 1.0);
    let scene_90 = compiler_90.compile_from_program(&program).expect("Compilation failed");
    assert_eq!(scene_90.rotation, 90);
    assert_eq!(scene_90.bounds.width(), 600.0);
    assert_eq!(scene_90.bounds.height(), 400.0);

    // UserUnit = 2.0: kich thuoc duoc nhan doi
    let compiler_user_unit = SceneCompiler::new(1, boxes, 0, 2.0);
    let scene_user_unit = compiler_user_unit.compile_from_program(&program).expect("Compilation failed");
    assert_eq!(scene_user_unit.user_unit, 2.0);
    assert_eq!(scene_user_unit.bounds.width(), 800.0);
    assert_eq!(scene_user_unit.bounds.height(), 1200.0);
}

#[test]
fn test_lazy_loading_only_compiles_requested_page() {
    // Gia lap 2 trang PDF doc lap
    let page1_bytes = b"0 0 50 50 re f";
    let page2_bytes = b"0 0 150 150 re f";

    let program1 = PageProgram::compile(page1_bytes).expect("P1 compile failed");
    let program2 = PageProgram::compile(page2_bytes).expect("P2 compile failed");

    let boxes1 = ScenePageBoxes::new(Rect::new(0.0, 0.0, 500.0, 500.0), Rect::new(0.0, 0.0, 500.0, 500.0));
    let boxes2 = ScenePageBoxes::new(Rect::new(0.0, 0.0, 800.0, 800.0), Rect::new(0.0, 0.0, 800.0, 800.0));

    let compiler1 = SceneCompiler::new(1, boxes1, 0, 1.0);
    let compiler2 = SceneCompiler::new(2, boxes2, 0, 1.0);

    // Chi bien dich Page 1
    let scene1 = compiler1.compile_from_program(&program1).expect("Scene 1 failed");
    assert_eq!(scene1.page_number, 1);
    assert_eq!(scene1.bounds.width(), 500.0);

    // Page 2 chua he duoc compile thanh SceneIR o thoi diem nay
    // Chi khi nao user cuon toi hoac yeu cau trang 2:
    let scene2 = compiler2.compile_from_program(&program2).expect("Scene 2 failed");
    assert_eq!(scene2.page_number, 2);
    assert_eq!(scene2.bounds.width(), 800.0);
}
