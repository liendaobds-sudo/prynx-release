//! PERF (audit 2026-09-11 §PPEBX.2): cache Form không đổi pixel/resource/provenance.
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::{write::ZlibEncoder, Compression};
use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{PageBox, PageRender, RasterClip};
use print_engine::{CancelToken, RenderSession};

fn compressed(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn form(doc: &mut Document, data: &[u8], recovered: bool, group: Option<bool>) -> Object {
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(),0.into(),30.into(),30.into()],
        "Filter" => "FlateDecode",
    };
    if let Some(isolated) = group {
        dict.set(
            "Group",
            dictionary! { "S" => "Transparency", "I" => isolated },
        );
    }
    Object::Reference(doc.add_object(Stream::new(
        dict,
        if recovered {
            data.to_vec()
        } else {
            compressed(data)
        },
    )))
}

fn finish(mut doc: Document, pages: Vec<(Vec<u8>, Dictionary)>) -> Vec<u8> {
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for (data, resources) in pages {
        let content = doc.add_object(Stream::new(dictionary! {}, data));
        kids.push(Object::Reference(doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0.into(),0.into(),100.into(),100.into()],
            "Resources" => resources, "Contents" => Object::Reference(content),
        })));
    }
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Count" => kids.len() as i64, "Kids" => kids },
    );
    let root =
        doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => Object::Reference(pages_id) });
    doc.trailer.set("Root", Object::Reference(root));
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

fn session(bytes: &[u8], budget: usize) -> RenderSession {
    RenderSession::open_mem(bytes, None)
        .unwrap()
        .with_resource_cache_budget(budget)
}

fn render(session: &mut RenderSession, page: usize) -> PageRender {
    session
        .render_page(page, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .unwrap()
}

fn assert_same(actual: &PageRender, expected: &PageRender) {
    assert_eq!(actual.buffer.width(), expected.buffer.width());
    assert_eq!(actual.buffer.height(), expected.buffer.height());
    assert_eq!(actual.buffer.space().len(), expected.buffer.space().len());
    for channel in 0..actual.buffer.space().len() {
        assert_eq!(actual.buffer.plane(channel), expected.buffer.plane(channel));
    }
    assert_eq!(
        format!("{:?}", actual.warnings),
        format!("{:?}", expected.warnings)
    );
}

fn repeated_pdf(recovered: bool, group: Option<bool>) -> Vec<u8> {
    let mut doc = Document::new();
    let mut body = b"0 0 0 1 k 2 2 20 20 re f\n%".to_vec();
    body.resize(356_135, b' ');
    body.extend_from_slice(b"\nq 5 0 0 5 20 20 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \x80 EI Q\n");
    let child = form(&mut doc, &body, recovered, group);
    let mut draws = Vec::new();
    for index in 0..9 {
        draws.extend_from_slice(
            format!(
                "q 0 0 95 95 re W n 1 0 0 1 {} {} cm /F Do Q\n",
                (index % 3) * 30,
                (index / 3) * 30
            )
            .as_bytes(),
        );
    }
    finish(
        doc,
        vec![(
            draws,
            dictionary! { "XObject" => dictionary! { "F" => child } },
        )],
    )
}

#[test]
fn repeated_form_reuses_program_with_pixel_and_group_parity() {
    for group in [None, Some(false), Some(true)] {
        let bytes = repeated_pdf(false, group);
        let mut cached = session(&bytes, 4 * 1024 * 1024);
        let mut uncached = session(&bytes, 0);
        assert_same(&render(&mut cached, 1), &render(&mut uncached, 1));
        let stats = cached.resource_cache_stats();
        assert_eq!(stats.form_misses, 1, "{stats:?}");
        assert_eq!(stats.form_hits, 8, "{stats:?}");
        assert!(stats.bytes > 0 && stats.bytes <= stats.budget_bytes);
        for dpi in [96.0, 144.0] {
            let clip = Some(RasterClip {
                x: 10,
                y: 12,
                width: 80,
                height: 75,
            });
            let actual = cached
                .render_page_region(1, dpi, PageBox::Crop, RenderOptions::softproof(), clip)
                .unwrap();
            let expected = uncached
                .render_page_region(1, dpi, PageBox::Crop, RenderOptions::softproof(), clip)
                .unwrap();
            assert_same(&actual, &expected);
        }
        assert_eq!(cached.resource_cache_stats().form_misses, 1);
    }
}

#[test]
fn inherited_resources_are_resolved_per_invocation_not_cached() {
    let mut doc = Document::new();
    let f = form(&mut doc, b"q 25 0 0 25 5 5 cm /Im Do Q", false, None);
    let mut pages = Vec::new();
    for gray in [0, 180] {
        let image = doc.add_object(Stream::new(
            dictionary! {
                "Type"=>"XObject", "Subtype"=>"Image", "Width"=>1, "Height"=>1,
                "BitsPerComponent"=>8, "ColorSpace"=>"DeviceGray",
            },
            vec![gray],
        ));
        pages.push((b"/F Do".to_vec(),dictionary! { "XObject"=>dictionary! { "F"=>f.clone(), "Im"=>Object::Reference(image) }}));
    }
    let bytes = finish(doc, pages);
    let mut cached = session(&bytes, 1024 * 1024);
    let mut uncached = session(&bytes, 0);
    let first = render(&mut cached, 1);
    assert_same(&first, &render(&mut uncached, 1));
    let second = render(&mut cached, 2);
    assert_same(&second, &render(&mut uncached, 2));
    assert_ne!(first.buffer.plane(3), second.buffer.plane(3));
    assert_eq!(cached.resource_cache_stats().form_hits, 1);
}

#[test]
fn recovered_form_warning_visibility_is_not_cached() {
    let mut doc = Document::new();
    let f = form(&mut doc, b"0 0 0 1 k 0 0 30 30 re f", true, None);
    let res = dictionary! {"XObject"=>dictionary! {"F"=>f}};
    let bytes = finish(
        doc,
        vec![
            (b"/F Do".to_vec(), res.clone()),
            (b"q 0 0 0 0 re W n /F Do Q".to_vec(), res),
        ],
    );
    for order in [[1, 2, 1], [2, 1, 2]] {
        let mut cached = session(&bytes, 1024 * 1024);
        let mut uncached = session(&bytes, 0);
        for page in order {
            let actual = render(&mut cached, page);
            assert_same(&actual, &render(&mut uncached, page));
            assert_eq!(actual.warnings.ink_unsound(), page == 1);
        }
        assert_eq!(cached.resource_cache_stats().form_misses, 1);
        assert_eq!(cached.resource_cache_stats().form_hits, 2);
    }
}

#[test]
fn zero_or_tiny_budget_and_shrink_keep_pixels_and_release_cache() {
    let bytes = repeated_pdf(false, None);
    let mut cached = session(&bytes, 1024 * 1024);
    let expected = render(&mut cached, 1);
    assert!(cached.resource_cache_stats().bytes > 0);
    for budget in [1, 0, 1024 * 1024] {
        cached.set_resource_cache_budget(budget);
        if budget <= 1 {
            assert_eq!(cached.resource_cache_stats().bytes, 0);
        }
        assert_same(&render(&mut cached, 1), &expected);
        assert!(cached.resource_cache_stats().bytes <= budget);
    }
    cached.close();
    assert_eq!(cached.resource_cache_stats().bytes, 0);
}

#[test]
fn cancelled_request_does_not_publish_program_and_next_request_works() {
    let bytes = repeated_pdf(false, None);
    let mut cached = session(&bytes, 1024 * 1024);
    let token = CancelToken::new();
    token.cancel();
    assert!(cached
        .render_page(
            1,
            72.0,
            PageBox::Crop,
            RenderOptions::ink_accurate().with_cancel_token(token)
        )
        .is_err());
    assert_eq!(cached.resource_cache_stats().bytes, 0);
    assert_same(&render(&mut cached, 1), &render(&mut session(&bytes, 0), 1));
}

#[test]
fn mixed_image_and_nested_forms_share_one_lru_budget() {
    let mut doc = Document::new();
    let image = Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type"=>"XObject", "Subtype"=>"Image", "Width"=>256, "Height"=>1,
            "BitsPerComponent"=>8, "ColorSpace"=>"DeviceGray",
        },
        vec![0; 256],
    )));
    let child = form(&mut doc, b"0 0 0 1 k 5 5 20 20 re f", false, None);
    let outer = form(&mut doc, b"/Child Do /Child Do", false, Some(false));
    let res = dictionary! {"XObject"=>dictionary! {"Outer"=>outer,"Child"=>child,"Im"=>image}};
    let bytes = finish(
        doc,
        vec![(
            b"/Outer Do q 20 0 0 20 5 5 cm /Im Do Q /Outer Do".to_vec(),
            res,
        )],
    );
    let expected = render(&mut session(&bytes, 0), 1);
    let mut cached = session(&bytes, 1024 * 1024);
    assert_same(&render(&mut cached, 1), &expected);
    let initial = cached.resource_cache_stats();
    assert_eq!(initial.form_misses, 2);
    assert!(initial.form_hits >= 3);
    assert!(initial.image_misses > 0);
    // Co budget sau khi cả hai loại có entry để buộc LRU hỗn hợp chạy.
    let small = initial.bytes / 2;
    cached.set_resource_cache_budget(small);
    assert!(cached.resource_cache_stats().bytes <= small);
    assert!(
        cached.resource_cache_stats().image_evictions
            + cached.resource_cache_stats().form_evictions
            > 0
    );
    assert_same(&render(&mut cached, 1), &expected);
    assert!(cached.resource_cache_stats().bytes <= small);
    let token = CancelToken::new();
    token.cancel();
    assert!(cached
        .render_page(
            1,
            72.0,
            PageBox::Crop,
            RenderOptions::ink_accurate().with_cancel_token(token)
        )
        .is_err());
    assert_same(&render(&mut cached, 1), &expected);
}

#[test]
fn save_over_same_object_id_invalidates_form_program() {
    let build = |marker: &[u8]| {
        let mut doc = Document::new();
        let f = form(&mut doc, marker, false, None);
        finish(
            doc,
            vec![(
                b"/F Do".to_vec(),
                dictionary! {"XObject"=>dictionary! {"F"=>f}},
            )],
        )
    };
    let path = std::env::temp_dir().join(format!(
        "ppe_form_cache_{}_{}.pdf",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(&path, build(b"0 0 0 1 k 0 0 30 30 re f")).unwrap();
    let mut cached = RenderSession::open(&path)
        .unwrap()
        .with_resource_cache_budget(1024 * 1024);
    let old = render(&mut cached, 1);
    let generation = cached.generation();
    std::fs::write(&path, build(b"0 0 0 0 k 0 0 30 30 re f % changed source")).unwrap();
    let new = render(&mut cached, 1);
    assert_ne!(old.buffer.plane(3), new.buffer.plane(3));
    assert!(cached.generation() > generation);
    assert_eq!(cached.resource_cache_stats().form_misses, 1);
    assert_eq!(cached.resource_cache_stats().form_hits, 0);
    cached.close();
    std::fs::remove_file(path).unwrap();
}
