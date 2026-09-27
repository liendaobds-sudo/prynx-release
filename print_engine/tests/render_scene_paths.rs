//! Integration tests cho Scene PathBuilder va Form Invocation Scope (Milestone G1.2)

use print_engine::geom::Rect;
use print_engine::page_program::PageProgram;
use print_engine::scene::path_builder::PathSegment;
use print_engine::scene::{SceneCommand, SceneCompiler, ScenePageBoxes};

#[test]
fn test_path_builder_bezier_and_close() {
    // Duong cong Bezier gom m, l, c va close h
    let content_bytes = b"10 10 m 50 10 l 60 20 70 30 80 50 c h f";
    let program = PageProgram::compile(content_bytes).expect("PageProgram compile failed");

    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 500.0, 500.0),
        Rect::new(0.0, 0.0, 500.0, 500.0),
    );
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let scene = compiler
        .compile_from_program(&program)
        .expect("Scene compile failed");

    assert_eq!(scene.command_count(), 1);
    match &scene.commands[0] {
        SceneCommand::Path(p) => {
            assert!(p.path_data.is_some());
            let path_data = p.path_data.as_ref().unwrap();
            assert_eq!(path_data.subpaths.len(), 1);

            let sp = &path_data.subpaths[0];
            assert!(sp.closed);
            assert_eq!(sp.segments.len(), 4); // MoveTo, LineTo, CubicTo, Close

            match sp.segments[0] {
                PathSegment::MoveTo(pt) => {
                    assert_eq!(pt.x, 10.0);
                    assert_eq!(pt.y, 10.0);
                }
                _ => panic!("Expected MoveTo"),
            }
            match sp.segments[1] {
                PathSegment::LineTo(pt) => {
                    assert_eq!(pt.x, 50.0);
                    assert_eq!(pt.y, 10.0);
                }
                _ => panic!("Expected LineTo"),
            }
            match sp.segments[2] {
                PathSegment::CubicTo { cp1, cp2, to } => {
                    assert_eq!(cp1.x, 60.0);
                    assert_eq!(cp1.y, 20.0);
                    assert_eq!(cp2.x, 70.0);
                    assert_eq!(cp2.y, 30.0);
                    assert_eq!(to.x, 80.0);
                    assert_eq!(to.y, 50.0);
                }
                _ => panic!("Expected CubicTo"),
            }
            match sp.segments[3] {
                PathSegment::Close => {}
                _ => panic!("Expected Close"),
            }

            // Kiem tra bounds bao quanh dung
            assert_eq!(p.bounds.x0, 10.0);
            assert_eq!(p.bounds.y0, 10.0);
            assert_eq!(p.bounds.x1, 80.0);
            assert_eq!(p.bounds.y1, 50.0);
        }
        _ => panic!("Expected Path command"),
    }
}

#[test]
fn test_path_builder_rectangle_operator() {
    let content_bytes = b"20 30 150 250 re f";
    let program = PageProgram::compile(content_bytes).expect("PageProgram compile failed");

    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 500.0, 500.0),
        Rect::new(0.0, 0.0, 500.0, 500.0),
    );
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let scene = compiler
        .compile_from_program(&program)
        .expect("Scene compile failed");

    assert_eq!(scene.command_count(), 1);
    match &scene.commands[0] {
        SceneCommand::Path(p) => {
            assert_eq!(p.bounds.x0, 20.0);
            assert_eq!(p.bounds.y0, 30.0);
            assert_eq!(p.bounds.width(), 150.0);
            assert_eq!(p.bounds.height(), 250.0);
        }
        _ => panic!("Expected Path command"),
    }
}

#[test]
fn test_ctm_transformation_applies_to_path_coordinates() {
    // Dich chuyen (50, 60) qua cm roi moi ve hinh vuong (0, 0, 100, 100)
    let content_bytes = b"1 0 0 1 50 60 cm 0 0 100 100 re f";
    let program = PageProgram::compile(content_bytes).expect("PageProgram compile failed");

    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 500.0, 500.0),
        Rect::new(0.0, 0.0, 500.0, 500.0),
    );
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let scene = compiler
        .compile_from_program(&program)
        .expect("Scene compile failed");

    match &scene.commands[0] {
        SceneCommand::Path(p) => {
            // Toa do da duoc bien doi qua CTM ngay tai buoc build SceneIR
            assert_eq!(p.bounds.x0, 50.0);
            assert_eq!(p.bounds.y0, 60.0);
            assert_eq!(p.bounds.x1, 150.0);
            assert_eq!(p.bounds.y1, 160.0);
        }
        _ => panic!("Expected Path command"),
    }
}

// PERF (audit 2026-09-25 §R25.GPU.02): không dùng Image 1x1 giả làm bằng chứng Form.
#[test]
fn unresolved_form_is_not_silently_converted_to_image() {
    let program = PageProgram::compile(b"/Fm1 Do").unwrap();
    let rect = Rect::new(0.0, 0.0, 100.0, 100.0);
    let error = SceneCompiler::new(1, ScenePageBoxes::new(rect, rect), 0, 1.0)
        .compile_from_program(&program)
        .unwrap_err();
    assert!(error.to_string().contains("Do"));
}

#[test]
fn curve_v_does_not_apply_ctm_to_current_point_twice() {
    let program = PageProgram::compile(b"2 0 0 2 10 20 cm 5 6 m 7 8 9 10 v S").unwrap();
    let rect = Rect::new(0.0, 0.0, 100.0, 100.0);
    let scene = SceneCompiler::new(1, ScenePageBoxes::new(rect, rect), 0, 1.0)
        .compile_from_program(&program)
        .unwrap();
    let SceneCommand::Path(path) = &scene.commands[0] else {
        panic!("Thiếu path");
    };
    let segments = &path.path_data.as_ref().unwrap().subpaths[0].segments;
    let PathSegment::MoveTo(start) = segments[0] else {
        panic!();
    };
    let PathSegment::CubicTo { cp1, .. } = segments[1] else {
        panic!();
    };
    assert_eq!(start, cp1);
    assert_eq!((cp1.x, cp1.y), (20.0, 32.0));
}
