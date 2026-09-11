//! PERF (audit 2026-09-11 §PPEBX.B): SMask giữ BC/TR và provenance khi cache/lazy.
use std::io::Write;

use flate2::{write::ZlibEncoder, Compression};
use lopdf::{dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{PageBox, PageRender, RasterClip};
use print_engine::RenderSession;

fn fixture(luminosity: bool, inverse: bool, recovered: bool) -> Vec<u8> {
    let mut doc = Document::new();
    let content = b"1 g 40 40 30 30 re f";
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(content).unwrap();
    let mask = doc.add_object(Stream::new(dictionary! {
        "Type"=>"XObject", "Subtype"=>"Form", "BBox"=>vec![40.into(),40.into(),70.into(),70.into()],
        "Group"=>dictionary! {"S"=>"Transparency","CS"=>"DeviceGray"},
        "Resources"=>dictionary! {}, "Filter"=>"FlateDecode",
    }, if recovered {content.to_vec()} else {encoder.finish().unwrap()}));
    let transfer = if inverse {
        Object::Dictionary(
            dictionary! {"FunctionType"=>2, "Domain"=>vec![0.into(),1.into()], "C0"=>vec![1.into()], "C1"=>vec![0.into()], "N"=>1},
        )
    } else {
        Object::Name(b"Identity".to_vec())
    };
    let smask = dictionary! {
        "S"=>if luminosity {"Luminosity"} else {"Alpha"}, "G"=>Object::Reference(mask),
        "BC"=>vec![Object::Real(0.25)], "TR"=>transfer,
    };
    let gs = doc.add_object(dictionary! {"SMask"=>smask});
    let pages = doc.new_object_id();
    let mut kids = Vec::new();
    // Trang 1 nhìn thấy G; trang 2 ngoài G và cả guard-band; trang 3 quay lại G.
    for operators in [
        b"/GS gs 0 0 0 1 k 0 0 80 80 re f /GS gs".as_slice(),
        b"q 0 0 5 5 re W n /GS gs 0 0 0 1 k 0 0 80 80 re f Q".as_slice(),
        b"/GS gs 0 0 0 1 k 0 0 80 80 re f".as_slice(),
    ] {
        let stream = doc.add_object(Stream::new(dictionary! {}, operators.to_vec()));
        kids.push(Object::Reference(doc.add_object(dictionary! {
            "Type"=>"Page", "Parent"=>Object::Reference(pages), "MediaBox"=>vec![0.into(),0.into(),80.into(),80.into()],
            "Contents"=>Object::Reference(stream), "Resources"=>dictionary! {"ExtGState"=>dictionary! {"GS"=>Object::Reference(gs)}},
        })));
    }
    doc.set_object(pages, dictionary! {"Type"=>"Pages","Count"=>3,"Kids"=>kids});
    let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>Object::Reference(pages)});
    doc.trailer.set("Root", Object::Reference(catalog));
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

fn render(session: &mut RenderSession, page: usize) -> PageRender {
    session
        .render_page(page, 72.0, PageBox::Crop, RenderOptions::softproof())
        .unwrap()
}

fn same(actual: &PageRender, expected: &PageRender) {
    for channel in 0..actual.buffer.space().len() {
        assert_eq!(actual.buffer.plane(channel), expected.buffer.plane(channel));
    }
    assert_eq!(
        format!("{:?}", actual.warnings),
        format!("{:?}", expected.warnings)
    );
}

#[test]
fn smask_reuses_program_only_after_nonempty_window_and_preserves_bc_tr() {
    for luminosity in [false, true] {
        for inverse in [false, true] {
            let bytes = fixture(luminosity, inverse, false);
            let mut cached = RenderSession::open_mem(&bytes, None)
                .unwrap()
                .with_resource_cache_budget(1024 * 1024);
            let mut uncached = RenderSession::open_mem(&bytes, None).unwrap();
            let outside = render(&mut cached, 2);
            same(&outside, &render(&mut uncached, 2));
            assert_eq!(
                cached.resource_cache_stats().form_misses,
                0,
                "G ngoài window không được lookup/decode"
            );
            let k = outside.buffer.plane(3);
            // Pixel (2,77) ở trong clip 5x5, ngoài BBox mask. Không được coi mask vắng mặt.
            let value = k[77 * 80 + 2];
            if !luminosity {
                assert_eq!(value, if inverse { 1.0 } else { 0.0 });
            } else {
                assert!(value > 0.1 && value < 0.9);
            }
            let first = render(&mut cached, 1);
            same(&first, &render(&mut uncached, 1));
            assert_eq!(cached.resource_cache_stats().form_misses, 1);
            assert!(cached.resource_cache_stats().form_hits >= 1);
            let before = cached.resource_cache_stats();
            same(&render(&mut cached, 2), &outside);
            assert_eq!(cached.resource_cache_stats().form_hits, before.form_hits);
            same(&render(&mut cached, 3), &render(&mut uncached, 3));
            assert_eq!(cached.resource_cache_stats().form_misses, 1);
            let region = Some(RasterClip {
                x: 10,
                y: 12,
                width: 65,
                height: 64,
            });
            let a = cached
                .render_page_region(1, 144.0, PageBox::Crop, RenderOptions::softproof(), region)
                .unwrap();
            let b = uncached
                .render_page_region(1, 144.0, PageBox::Crop, RenderOptions::softproof(), region)
                .unwrap();
            same(&a, &b);
        }
    }
}

#[test]
fn recovered_smask_cached_program_does_not_reuse_visibility_events() {
    let bytes = fixture(false, false, true);
    let mut cached = RenderSession::open_mem(&bytes, None)
        .unwrap()
        .with_resource_cache_budget(1024 * 1024);
    let mut uncached = RenderSession::open_mem(&bytes, None).unwrap();
    for page in [2, 1, 2, 3] {
        let a = render(&mut cached, page);
        same(&a, &render(&mut uncached, page));
        assert_eq!(a.warnings.ink_unsound(), page != 2);
    }
    assert_eq!(cached.resource_cache_stats().form_misses, 1);
    assert!(cached.resource_cache_stats().form_hits >= 2);
}
