//! Integration tests cho CPU Replay Graph & Interpreter Parity (Milestone G1.4)
//!
//! Kiem tra tinh nhat quan tuyet doi (Parity) giua bo thuc thi moi (CpuSceneReplayer
//! qua SceneIR + RenderGraph) va interpreter truyen thong (Renderer / render_page).
//!
//! Kiem thu tren:
//! 1. Vector CMYK rectangle fill parity
//! 2. CTM translation + Bezier cubic curve parity
//! 3. Overprint mode OPM=1 ink preservation
//! 4. Stroke path rendering parity
//! 5. Separation / Spot color painting parity

use lopdf::{dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::cpu_scene::CpuSceneReplayer;
use print_engine::geom::Rect;
use print_engine::page::{device_matrix, render_page, PageBox};
use print_engine::page_program::PageProgram;
use print_engine::render_graph::builder::RenderGraphBuilder;
use print_engine::scene::{SceneCompiler, ScenePageBoxes};

fn create_test_pdf(content: &str, width: f32, height: f32) -> Document {
    let mut doc = Document::with_version("1.7");
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "MediaBox" => vec![0.into(), 0.into(), (width as i64).into(), (height as i64).into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

#[test]
fn test_parity_vector_cmyk_rectangle_fill() {
    // Ve hinh chu nhat mau Magenta (0, 1, 0, 0) tai (15, 20), rong 70, cao 50 tren trang 100x100
    let content = "0 1 0 0 k 15 20 70 50 re f";
    let doc = create_test_pdf(content, 100.0, 100.0);

    let opts = RenderOptions::ink_accurate();
    let legacy = render_page(&doc, 1, 72.0, PageBox::Media, opts.clone()).expect("Legacy render failed");

    // Replay qua SceneIR + RenderGraph + CpuSceneReplayer
    let boxes = ScenePageBoxes::new(Rect::new(0.0, 0.0, 100.0, 100.0), Rect::new(0.0, 0.0, 100.0, 100.0));
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let program = PageProgram::compile(content.as_bytes()).expect("Compile PageProgram failed");
    let scene = compiler.compile_from_program(&program).expect("Compile SceneIR failed");
    let graph = RenderGraphBuilder::new().build_from_scene(&scene);

    let replayer = CpuSceneReplayer::new(opts);
    let dev_matrix = device_matrix(&boxes.effective_rect(), 72.0, 0);
    let replayed = replayer
        .replay_graph(&scene, &graph, 100, 100, dev_matrix)
        .expect("CPU Replay failed");

    assert_eq!(legacy.buffer.width(), replayed.width());
    assert_eq!(legacy.buffer.height(), replayed.height());

    // Doi chieu tung kenh C, M, Y, K
    for ch in 0..4 {
        let leg_plane = legacy.buffer.plane(ch);
        let rep_plane = replayed.plane(ch);
        assert_eq!(leg_plane.len(), rep_plane.len());

        let mut max_diff = 0.0f32;
        let mut diff_count = 0;
        for (l, r) in leg_plane.iter().zip(rep_plane.iter()) {
            let d = (l - r).abs();
            if d > max_diff {
                max_diff = d;
            }
            if d > 1e-4 {
                diff_count += 1;
            }
        }
        assert!(
            max_diff < 1e-3,
            "Kenh {ch} chenh lech qua muc: max_diff = {max_diff}, so pixel lech = {diff_count}"
        );
    }
}

#[test]
fn test_parity_ctm_translation_and_bezier_curves() {
    // Bien doi cm dich chuyen (10, 15) roi ve duong cong Bezier kin voi mau Cyan (1, 0, 0, 0)
    let content = "1 0 0 1 10 15 cm 1 0 0 0 k 10 10 m 40 10 l 50 20 60 30 70 40 c h f";
    let doc = create_test_pdf(content, 120.0, 120.0);

    let opts = RenderOptions::ink_accurate();
    let legacy = render_page(&doc, 1, 72.0, PageBox::Media, opts.clone()).expect("Legacy render failed");

    let boxes = ScenePageBoxes::new(Rect::new(0.0, 0.0, 120.0, 120.0), Rect::new(0.0, 0.0, 120.0, 120.0));
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let program = PageProgram::compile(content.as_bytes()).expect("Compile PageProgram failed");
    let scene = compiler.compile_from_program(&program).expect("Compile SceneIR failed");
    let graph = RenderGraphBuilder::new().build_from_scene(&scene);

    let replayer = CpuSceneReplayer::new(opts);
    let dev_matrix = device_matrix(&boxes.effective_rect(), 72.0, 0);
    let replayed = replayer
        .replay_graph(&scene, &graph, 120, 120, dev_matrix)
        .expect("CPU Replay failed");

    // Kenh Cyan (ch=0) phai co pixel duoc to
    let cyan_pixels: usize = replayed.plane(0).iter().filter(|&&v| v > 0.1).count();
    assert!(cyan_pixels > 0, "Kenh Cyan phai co pixel duoc to");

    // So sanh voi legacy
    for ch in 0..4 {
        let leg_plane = legacy.buffer.plane(ch);
        let rep_plane = replayed.plane(ch);
        let mut max_diff = 0.0f32;
        for (l, r) in leg_plane.iter().zip(rep_plane.iter()) {
            let d = (l - r).abs();
            if d > max_diff {
                max_diff = d;
            }
        }
        assert!(max_diff < 0.05, "Kenh {ch} lech: max_diff = {max_diff}");
    }
}

#[test]
fn test_parity_overprint_opm1_ink_preservation() {
    // Kiem tra tinh chat bao toan kenh nen khi overprint (OPM=1):
    // Ve nen Cyan: 1 0 0 0 k
    // Sau do ve de chu nhat mau Black: 0 0 0 1 k voi overprint bat
    let content = "1 0 0 0 k 10 10 80 80 re f 0 0 0 1 k 30 30 40 40 re f";
    let boxes = ScenePageBoxes::new(Rect::new(0.0, 0.0, 100.0, 100.0), Rect::new(0.0, 0.0, 100.0, 100.0));
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let program = PageProgram::compile(content.as_bytes()).expect("Compile PageProgram failed");
    let mut scene = compiler.compile_from_program(&program).expect("Compile SceneIR failed");

    // Bat overprint cho lenh ve thu hai (hinh chu nhat mau den)
    if let Some(cmd) = scene.commands.get_mut(1) {
        if let print_engine::scene::SceneCommand::Path(ref mut p) = cmd {
            p.overprint = true;
        }
    }

    let graph = RenderGraphBuilder::new().build_from_scene(&scene);
    let replayer = CpuSceneReplayer::new(RenderOptions::ink_accurate());
    let dev_matrix = device_matrix(&boxes.effective_rect(), 72.0, 0);
    let buffer = replayer
        .replay_graph(&scene, &graph, 100, 100, dev_matrix)
        .expect("CPU Replay failed");

    // Vung trung tam (x=50, y=50 trong pixel) phai giu ca Cyan = 1.0 va Black = 1.0
    // (Bao toan muc nen theo ISO 32000-2 §11.7.4.4 OPM=1)
    let idx = 50 * 100 + 50;
    let cyan_val = buffer.plane(0)[idx];
    let black_val = buffer.plane(3)[idx];
    assert!(cyan_val > 0.9, "Nen Cyan phai duoc giu nguyen khi Overprint OPM=1 (thuc te: {cyan_val})");
    assert!(black_val > 0.9, "Muc Black phai phu tren lop tren (thuc te: {black_val})");
}

#[test]
fn test_parity_stroke_path_rendering() {
    // Ve duong vien Stroke voi mau Black, stroke_width = 4.0
    let content = "0 0 0 1 K 4 w 20 20 m 80 80 l S";
    let doc = create_test_pdf(content, 100.0, 100.0);

    let opts = RenderOptions::ink_accurate();
    let legacy = render_page(&doc, 1, 72.0, PageBox::Media, opts.clone()).expect("Legacy render failed");

    let boxes = ScenePageBoxes::new(Rect::new(0.0, 0.0, 100.0, 100.0), Rect::new(0.0, 0.0, 100.0, 100.0));
    let compiler = SceneCompiler::new(1, boxes, 0, 1.0);
    let program = PageProgram::compile(content.as_bytes()).expect("Compile PageProgram failed");
    let scene = compiler.compile_from_program(&program).expect("Compile SceneIR failed");
    let graph = RenderGraphBuilder::new().build_from_scene(&scene);

    let replayer = CpuSceneReplayer::new(opts);
    let dev_matrix = device_matrix(&boxes.effective_rect(), 72.0, 0);
    let replayed = replayer
        .replay_graph(&scene, &graph, 100, 100, dev_matrix)
        .expect("CPU Replay failed");

    // Kenh Black (ch=3) phai co pixel duoc ve
    let stroke_pixels: usize = replayed.plane(3).iter().filter(|&&v| v > 0.1).count();
    assert!(stroke_pixels > 0, "Kenh Black phai chua cac pixel cua duong Stroke");

    // Kiem tra parity voi legacy
    let leg_black = legacy.buffer.plane(3);
    let rep_black = replayed.plane(3);
    let leg_count = leg_black.iter().filter(|&&v| v > 0.1).count();
    let rep_count = rep_black.iter().filter(|&&v| v > 0.1).count();

    // Do khac biet nho giua hairline/device rounding, tong so pixel phai chenh lech < 10%
    let diff_ratio = (leg_count as f32 - rep_count as f32).abs() / (leg_count as f32).max(1.0);
    assert!(
        diff_ratio < 0.10,
        "So pixel stroke lech giua legacy ({leg_count}) va replay ({rep_count}): ratio = {diff_ratio}"
    );
}
