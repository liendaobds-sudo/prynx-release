//! Integration tests cho Render Graph va Conservative Bounds Culling (Milestone G1.3)

use print_engine::geom::Rect;
use print_engine::page_program::PageProgram;
use print_engine::render_graph::{RenderGraphBuilder, RenderPassKind};
use print_engine::scene::{SceneCompiler, ScenePageBoxes};

#[test]
fn test_render_graph_construction_from_scene_ir() {
    let content_bytes = b"10 10 50 50 re f 100 100 80 80 re f";
    let program = PageProgram::compile(content_bytes).expect("Compile failed");

    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 1000.0, 1000.0),
        Rect::new(0.0, 0.0, 1000.0, 1000.0),
    );
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let scene = compiler
        .compile_from_program(&program)
        .expect("Scene compile failed");

    let builder = RenderGraphBuilder::new();
    let graph = builder.build_from_scene(&scene);

    assert!(!graph.is_empty());
    // 2 raster passes + 1 color resolve pass = 3 nodes
    assert_eq!(graph.nodes.len(), 3);

    // Kiem tra node cuoi cung la ColorResolvePass
    let last_node = &graph.nodes[2];
    match &last_node.kind {
        RenderPassKind::ColorResolvePass {
            proof_mode,
            overprint_simulation,
        } => {
            assert!(proof_mode);
            assert!(overprint_simulation);
        }
        _ => panic!("Node cuoi cung phai la ColorResolvePass"),
    }
}

#[test]
fn test_conservative_bounds_culling_filters_offscreen_objects() {
    // 3 hinh chu nhat:
    // H1: (10, 10, 50, 50) -> Nam trong viewport (0, 0, 200, 200)
    // H2: (60, 60, 40, 40) -> Nam trong viewport
    // H3: (800, 800, 100, 100) -> Nam HOAN TOAN NGOAI viewport
    let content_bytes = b"10 10 50 50 re f 60 60 40 40 re f 800 800 100 100 re f";
    let program = PageProgram::compile(content_bytes).expect("Compile failed");

    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 1000.0, 1000.0),
        Rect::new(0.0, 0.0, 1000.0, 1000.0),
    );
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let scene = compiler
        .compile_from_program(&program)
        .expect("Scene compile failed");

    // Khung nhin chi bao gom goc tren trai (0, 0, 200, 200)
    let viewport = Rect::new(0.0, 0.0, 200.0, 200.0);
    let builder = RenderGraphBuilder::new().with_visible_rect(viewport);
    let graph = builder.build_from_scene(&scene);

    // H3 da bi cull thanh cong
    assert_eq!(graph.culled_nodes_count, 1);
    // Graph chi con H1, H2 va ColorResolvePass = 3 nodes
    assert_eq!(graph.nodes.len(), 3);
}

#[test]
fn test_backdrop_preservation_in_non_isolated_group() {
    // Doi tuong nam trong nhom non-isolated group (q ... Q)
    // Backdrop du nam ngoai khung nhin mot phan nhung khong duoc cat bo
    // de tranh lam sai lech ket qua hoa tron transparency
    let content_bytes = b"q 800 800 100 100 re f Q";
    let program = PageProgram::compile(content_bytes).expect("Compile failed");

    let boxes = ScenePageBoxes::new(
        Rect::new(0.0, 0.0, 1000.0, 1000.0),
        Rect::new(0.0, 0.0, 1000.0, 1000.0),
    );
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let scene = compiler
        .compile_from_program(&program)
        .expect("Scene compile failed");

    let viewport = Rect::new(0.0, 0.0, 200.0, 200.0);
    // Force all nodes de kiem tra baseline
    let builder_full = RenderGraphBuilder::new()
        .with_visible_rect(viewport)
        .with_force_all_nodes(true);
    let graph_full = builder_full.build_from_scene(&scene);

    assert_eq!(graph_full.culled_nodes_count, 0);
}

#[test]
fn clip_outside_viewport_is_not_culled_as_soft_mask() {
    let p = PageProgram::compile(b"200 200 10 10 re W n 0 0 20 20 re f").unwrap();
    let r = Rect::new(0., 0., 300., 300.);
    let scene = SceneCompiler::new(1, ScenePageBoxes::new(r, r), 0, 1.)
        .compile_from_program(&p)
        .unwrap();
    let graph = RenderGraphBuilder::new()
        .with_visible_rect(Rect::new(0., 0., 100., 100.))
        .build_from_scene(&scene);
    assert!(matches!(
        graph.nodes[0].kind,
        RenderPassKind::ClipPush { .. }
    ));
    assert!(!graph
        .nodes
        .iter()
        .any(|n| matches!(n.kind, RenderPassKind::SoftMaskPass { .. })));
}

#[test]
fn group_blend_depends_on_children_and_backdrop_and_runs_last() {
    use print_engine::scene::{SceneCommand, SceneGroupPush};
    let r = Rect::new(0., 0., 100., 100.);
    let mut scene = SceneCompiler::new(1, ScenePageBoxes::new(r, r), 0, 1.)
        .compile_from_program(&PageProgram::compile(b"0 0 50 50 re f 50 50 50 50 re f").unwrap())
        .unwrap();
    scene.commands.insert(
        1,
        SceneCommand::PushGroup(SceneGroupPush {
            id: 50,
            isolated: false,
            knockout: false,
            blend_mode: "Normal".into(),
            alpha: 0.5,
            bounds: r,
        }),
    );
    scene.commands.push(SceneCommand::PopGroup);
    let graph = RenderGraphBuilder::new().build_from_scene(&scene);
    assert!(matches!(
        graph.nodes[1].kind,
        RenderPassKind::BeginGroup { .. }
    ));
    assert!(matches!(
        graph.nodes[2].kind,
        RenderPassKind::RasterPass { .. }
    ));
    assert!(matches!(
        graph.nodes[3].kind,
        RenderPassKind::GroupBlendPass { .. }
    ));
    for i in 0..3 {
        assert!(graph.nodes[3].inputs.contains(&graph.nodes[i].id));
    }
    assert!(graph.validation_errors.is_empty());
}
