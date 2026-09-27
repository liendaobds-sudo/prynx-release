// PERF (audit 2026-09-25 §R25.GPU.02–03): kiểm nội dung thực, không đếm command giả.
use print_engine::{
    geom::Rect,
    page_program::PageProgram,
    scene::{SceneCommand, SceneCompiler, ScenePageBoxes},
};
#[test]
fn scene_preserves_actual_text() {
    let p = PageProgram::compile(b"BT /F1 24 Tf 10 20 Td (Hello) Tj ET").unwrap();
    let boxes = ScenePageBoxes::new(Rect::new(0., 0., 100., 100.), Rect::new(0., 0., 100., 100.));
    let scene = SceneCompiler::new(1, boxes, 0, 1.)
        .compile_from_program(&p)
        .unwrap();
    let text = scene
        .commands
        .iter()
        .find_map(|c| match c {
            SceneCommand::Text(t) => Some(t),
            _ => None,
        })
        .unwrap();
    println!(
        "observed_text={:?}; observed_font={}; observed_size={}",
        text.text, text.font_name, text.font_size
    );
    assert_eq!(text.text, "Hello", "Compiler phải giữ nội dung chữ");
}

#[test]
fn cpu_replay_preserves_clip() {
    use lopdf::{dictionary, Document, Object, Stream};
    use print_engine::{
        content::RenderOptions,
        cpu_scene::CpuSceneReplayer,
        page::{device_matrix, render_page, PageBox},
        render_graph::builder::RenderGraphBuilder,
    };
    let content = b"q 10 10 20 20 re W n 1 0 0 0 k 0 0 100 100 re f Q";
    let mut doc = Document::with_version("1.7");
    let stream = doc.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary!{"Type"=>"Page","Parent"=>Object::Reference(pages),"Contents"=>Object::Reference(stream),"MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()]});
    doc.set_object(
        pages,
        dictionary! {"Type"=>"Pages","Kids"=>vec![Object::Reference(page)],"Count"=>1},
    );
    let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>Object::Reference(pages)});
    doc.trailer.set("Root", Object::Reference(cat));
    let opts = RenderOptions::ink_accurate();
    let old = render_page(&doc, 1, 72., PageBox::Media, opts.clone()).unwrap();
    let boxes = ScenePageBoxes::new(Rect::new(0., 0., 100., 100.), Rect::new(0., 0., 100., 100.));
    let scene = SceneCompiler::new(1, boxes, 0, 1.)
        .compile_from_program(&PageProgram::compile(content).unwrap())
        .unwrap();
    let graph = RenderGraphBuilder::new().build_from_scene(&scene);
    let new = CpuSceneReplayer::new(opts)
        .replay_graph(
            &scene,
            &graph,
            100,
            100,
            device_matrix(&boxes.effective_rect(), 72., 0),
        )
        .unwrap();
    let old_count = old.buffer.plane(0).iter().filter(|&&v| v > 0.5).count();
    let new_count = new.plane(0).iter().filter(|&&v| v > 0.5).count();
    println!("clipped_cyan_pixels: old={old_count}, scene_replay={new_count}");
    assert_eq!(
        old_count, new_count,
        "Clip 20x20 không được biến thành tô toàn trang"
    );
}

#[test]
fn replay_never_succeeds_after_dropping_text() {
    use print_engine::{
        content::RenderOptions, cpu_scene::CpuSceneReplayer, geom::Matrix,
        render_graph::RenderGraphBuilder,
    };
    let r = Rect::new(0., 0., 100., 100.);
    let scene = SceneCompiler::new(1, ScenePageBoxes::new(r, r), 0, 1.)
        .compile_from_program(&PageProgram::compile(b"BT /F1 24 Tf (Hello) Tj ET").unwrap())
        .unwrap();
    let graph = RenderGraphBuilder::new().build_from_scene(&scene);
    let error = CpuSceneReplayer::new(RenderOptions::ink_accurate())
        .replay_graph(&scene, &graph, 100, 100, Matrix::IDENTITY)
        .err()
        .expect("Không được trả trang trắng thành công");
    assert!(error.to_string().contains("resource"));
}

#[test]
fn resources_and_colors_never_become_placeholders() {
    use print_engine::{
        cpu_scene::scene_color_to_ink_paint,
        ink::InkSpace,
        scene::{SceneColor, SceneColorSpace},
    };
    let r = Rect::new(0., 0., 100., 100.);
    for bytes in [
        b"/Fm1 Do".as_slice(),
        b"/GS1 gs",
        b"/S1 sh",
        b"/DeviceN cs",
        b"[(A) 10 (B)] TJ",
    ] {
        assert!(SceneCompiler::new(1, ScenePageBoxes::new(r, r), 0, 1.)
            .compile_from_program(&PageProgram::compile(bytes).unwrap())
            .is_err());
    }
    let color = SceneColor {
        space: SceneColorSpace::DeviceRGB,
        components: vec![1., 0., 0.],
    };
    assert!(scene_color_to_ink_paint(&color, 1., false, &InkSpace::preview()).is_err());
}

#[test]
fn q_restores_clip_and_is_not_a_transparency_group() {
    use print_engine::{
        content::RenderOptions, cpu_scene::CpuSceneReplayer, geom::Matrix,
        render_graph::RenderGraphBuilder,
    };
    let r = Rect::new(0., 0., 100., 100.);
    let program = PageProgram::compile(b"q 0 0 10 10 re W n Q 1 0 0 0 k 0 0 100 100 re f").unwrap();
    let scene = SceneCompiler::new(1, ScenePageBoxes::new(r, r), 0, 1.)
        .compile_from_program(&program)
        .unwrap();
    assert!(!scene
        .commands
        .iter()
        .any(|c| matches!(c, SceneCommand::PushGroup(_))));
    let graph = RenderGraphBuilder::new().build_from_scene(&scene);
    let ink = CpuSceneReplayer::new(RenderOptions::ink_accurate())
        .replay_graph(&scene, &graph, 100, 100, Matrix::IDENTITY)
        .unwrap();
    assert_eq!(ink.plane(0).iter().filter(|&&v| v > 0.5).count(), 10000);
}

#[test]
fn stroke_bounds_survive_culling_outside_centerline() {
    use print_engine::render_graph::{RenderGraphBuilder, RenderPassKind};
    let r = Rect::new(0., 0., 100., 100.);
    let scene = SceneCompiler::new(1, ScenePageBoxes::new(r, r), 0, 1.)
        .compile_from_program(&PageProgram::compile(b"20 w 10 10 m 10 90 l S").unwrap())
        .unwrap();
    let graph = RenderGraphBuilder::new()
        .with_visible_rect(Rect::new(15., 20., 18., 40.))
        .build_from_scene(&scene);
    assert!(graph
        .nodes
        .iter()
        .any(|n| matches!(n.kind, RenderPassKind::RasterPass { .. })));
}
