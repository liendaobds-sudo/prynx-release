//! QUALITY (audit 2026-09-28 §KNOCK.C2b): kiểm độc lập provenance của
//! `/SMask`, mặt nạ Luminosity và ảnh trong nhóm knockout. Các oracle dưới đây
//! chỉ dùng công thức alpha/shape ISO 32000, không gọi helper compositor PPE.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 40;
const BACKDROP: [f64; 4] = [0.2, 0.4, 0.6, 0.3];
const SIBLING: [f64; 4] = [0.0, 1.0, 0.0, 0.0];

fn numbers(values: &[f64]) -> Object {
    Object::Array(values.iter().map(|v| Object::Real(*v as f32)).collect())
}

fn form(
    doc: &mut Document,
    content: &str,
    resources: Dictionary,
    isolated: bool,
    knockout: bool,
) -> Object {
    Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "Resources" => resources,
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK", "I" => isolated, "K" => knockout },
        },
        content.as_bytes().to_vec(),
    )))
}

fn image_mask(doc: &mut Document, alpha: u8, width: i64, height: i64) -> Object {
    Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => width,
            "Height" => height, "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
        },
        vec![alpha; (width * height) as usize],
    )))
}

fn explicit_image_mask(doc: &mut Document, visible: bool) -> Object {
    Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "ImageMask" => true, "BitsPerComponent" => 1,
        },
        vec![if visible { 0b1000_0000 } else { 0 }],
    )))
}

fn cmyk_image(doc: &mut Document, intrinsic: Option<Object>, explicit: Option<Object>) -> Object {
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
        "BitsPerComponent" => 8, "ColorSpace" => "DeviceCMYK",
    };
    if let Some(mask) = intrinsic { dict.set("SMask", mask); }
    if let Some(mask) = explicit { dict.set("Mask", mask); }
    Object::Reference(doc.add_object(Stream::new(dict, vec![0, 0, 0, 255])))
}

fn gray_image(doc: &mut Document, value: u8) -> Object {
    Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
        },
        vec![value],
    )))
}

fn host_alpha_mask(doc: &mut Document, alpha: u8) -> Object {
    let opacity = alpha as f32 / 255.0;
    form(
        doc,
        "0 0 0 1 k /A gs 0 0 40 40 re f",
        dictionary! { "ExtGState" => dictionary! {
            "A" => dictionary! { "ca" => opacity },
        } },
        true,
        false,
    )
}

fn host_luminosity_mask(doc: &mut Document, value: u8, isolated: bool, knockout: bool, tr: Option<Object>) -> Object {
    let image = gray_image(doc, value);
    let mut mask = dictionary! {
        "S" => "Luminosity", "G" => form(
            doc,
            "q 40 0 0 40 0 0 cm /Gray Do Q",
            dictionary! { "XObject" => dictionary! { "Gray" => image } },
            isolated,
            knockout,
        ),
        "BC" => numbers(&[1., 1., 1., 1.]),
    };
    if let Some(tr) = tr { mask.set("TR", tr); }
    Object::Dictionary(mask)
}

fn render_document(
    group_content: &str,
    group_resources: Dictionary,
    outer_blend: &str,
    isolated: bool,
    knockout: bool,
) -> Document {
    let mut doc = Document::with_version("1.7");
    let group = form(&mut doc, group_content, group_resources, isolated, knockout);
    let resources = dictionary! {
        "XObject" => dictionary! { "Outer" => group },
        "ExtGState" => dictionary! { "OuterBlend" => dictionary! { "BM" => outer_blend } },
    };
    let contents = doc.add_object(Stream::new(
        dictionary! {},
        b"0.2 0.4 0.6 0.3 k 0 0 40 40 re f /OuterBlend gs /Outer Do".to_vec(),
    ));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => contents, "Resources" => resources,
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
    });
    doc.set_object(pages, dictionary! {
        "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1,
    });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    doc
}

fn render(doc: &Document) -> PageRender {
    render_page(doc, 1, 72., PageBox::Crop, RenderOptions::softproof())
        .expect("Fixture SMask/ảnh phải render được")
}

fn guard_count(page: &PageRender) -> u32 {
    page.warnings
        .skipped_ops
        .iter()
        .filter(|(reason, _)| reason.contains("knockout"))
        .map(|(_, count)| *count)
        .sum()
}

fn pixel(page: &PageRender, x: usize, y: usize) -> [f64; 4] {
    let index = y * page.buffer.width() as usize + x;
    std::array::from_fn(|channel| page.buffer.plane(channel)[index] as f64)
}

fn assert_pixel(page: &PageRender, x: usize, y: usize, expected: [f64; 4], context: &str) {
    let actual = pixel(page, x, y);
    for (channel, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
        assert!((actual - expected).abs() < 4e-6,
            "{context}: kênh{channel} actual={actual}, expected={expected}; warnings={:?}", page.warnings);
    }
}

fn knockout_image_document(alpha: u8, ais: bool, intrinsic: Option<Object>, host: Option<Object>) -> Document {
    let mut doc = Document::with_version("1.7");
    let image = cmyk_image(&mut doc, intrinsic, None);
    let mut gs = dictionary! { "ca" => 1.0, "AIS" => ais };
    if let Some(mask) = host { gs.set("SMask", mask); }
    let group = form(
        &mut doc,
        "0 1 0 0 k 4 4 32 32 re f /A gs q 16 0 0 16 12 12 cm /Im Do Q",
        dictionary! {
            "XObject" => dictionary! { "Im" => image },
            "ExtGState" => dictionary! { "A" => gs },
        },
        false,
        true,
    );
    // Keep alpha in the fixture's object graph so all values are driven by the
    // image SMask/host SMask passed by the caller, not by a hidden constant.
    let _ = alpha;
    let contents = doc.add_object(Stream::new(dictionary! {},
        b"0.2 0.4 0.6 0.3 k 0 0 40 40 re f /Outer Do".to_vec()));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => contents,
        "Resources" => dictionary! { "XObject" => dictionary! { "Outer" => group } },
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
    });
    doc.set_object(pages, dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    doc
}

fn expected_image(alpha: f64, ais: bool) -> [f64; 4] {
    // The first sibling is full Magenta. An intrinsic `/SMask` replaces the
    // host mask, so effective opacity is alpha; AIS controls only erased shape.
    if ais {
        // AIS=true treats opacity as shape: the M sibling is only erased by
        // alpha, while the CMYK backdrop was already erased by that sibling.
        [0.0, 1.0 - alpha, 0.0, alpha]
    } else {
        // AIS=false uses a full geometric shape, so the sibling is fully
        // erased and the original page backdrop remains under translucent K.
        [
            0.2 * (1.0 - alpha),
            0.4 * (1.0 - alpha),
            0.6 * (1.0 - alpha),
            0.3 * (1.0 - alpha) + alpha,
        ]
    }
}

#[test]
fn intrinsic_gray_smask_overrides_host_alpha_mask_and_keeps_shape_numeric() {
    for ais in [false, true] {
        for alpha in [0u8, 128, 255] {
            let mut doc = Document::with_version("1.7");
            let intrinsic = image_mask(&mut doc, alpha, 1, 1);
            let host = host_alpha_mask(&mut doc, 0);
            let image = cmyk_image(&mut doc, Some(intrinsic), None);
            let group = form(&mut doc,
                "0 1 0 0 k 4 4 32 32 re f /A gs q 16 0 0 16 12 12 cm /Im Do Q",
                dictionary! {
                    "XObject" => dictionary! { "Im" => image },
                        "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 1., "AIS" => ais,
                            "SMask" => dictionary! { "S" => "Alpha", "G" => host } } },
                }, false, true);
            // A separate document resource tree keeps all objects in the same
            // xref and matches the Form lookup used by production.
            let contents = doc.add_object(Stream::new(dictionary! {}, b"0.2 0.4 0.6 0.3 k 0 0 40 40 re f /Outer Do".to_vec()));
            let pages = doc.new_object_id();
            let page = doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages, "Contents" => contents,
                "Resources" => dictionary! { "XObject" => dictionary! { "Outer" => group } },
                "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
            });
            doc.set_object(pages, dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 });
            let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
            doc.trailer.set("Root", catalog);
            let page = render(&doc);
            let a = alpha as f64 / 255.;
            eprintln!("intrinsic ais={ais} alpha={alpha} center={:?} outside={:?} warnings={:?}", pixel(&page,20,20), pixel(&page,7,20), page.warnings);
            assert_pixel(&page, 20, 20, expected_image(a, ais), "intrinsic SMask wins host alpha=0");
            assert_eq!(page.warnings.dropped_objects, 0);
            assert_eq!(guard_count(&page), 0, "certpositive after C2b wiring: {:?}", page.warnings);
        }
    }
}

fn image_scene(intrinsic_alpha: Option<u8>, explicit_alpha: Option<u8>, host_alpha: Option<u8>, ais: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let intrinsic = intrinsic_alpha.map(|value| image_mask(&mut doc, value, 1, 1));
    let explicit = explicit_alpha.map(|value| explicit_image_mask(&mut doc, value > 0));
    let image = cmyk_image(&mut doc, intrinsic, explicit);
    let mut gs = dictionary! { "ca" => 1., "AIS" => ais };
    if let Some(alpha) = host_alpha {
        let host_form = host_alpha_mask(&mut doc, alpha);
        gs.set("SMask", dictionary! { "S" => "Alpha", "G" => host_form });
    }
    let group = form(
        &mut doc,
        "0 1 0 0 k 4 4 32 32 re f /A gs q 16 0 0 16 12 12 cm /Im Do Q",
        dictionary! {
            "XObject" => dictionary! { "Im" => image },
            "ExtGState" => dictionary! { "A" => gs },
        },
        false,
        true,
    );
    let contents = doc.add_object(Stream::new(dictionary! {},
        b"0.2 0.4 0.6 0.3 k 0 0 40 40 re f /Outer Do".to_vec()));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => contents,
        "Resources" => dictionary! { "XObject" => dictionary! { "Outer" => group } },
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
    });
    doc.set_object(pages, dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    doc
}

fn effective_image_expectation(alpha: f64, ais: bool) -> [f64; 4] {
    expected_image(alpha, ais)
}

#[test]
fn host_alpha_mask_applies_to_plain_image_but_intrinsic_smask_replaces_it() {
    for ais in [false, true] {
        for alpha in [0.0f64, 0.5, 1.0] {
            let plain = render(&image_scene(None, None, Some(128), ais));
            eprintln!("plain ais={ais} pix={:?} warnings={:?}", pixel(&plain,20,20), plain.warnings);
            let host_alpha = 128.0 / 255.0;
            assert_pixel(&plain, 20, 20, effective_image_expectation(host_alpha, ais), "host Alpha controls plain image");
            assert_eq!(guard_count(&plain), 0, "plain image certificate RED/green boundary: {:?}", plain.warnings);

            let encoded_alpha = (alpha * 255.0).round() as u8;
            let page = render(&image_scene(Some(encoded_alpha), None, Some(0), ais));
            let decoded_alpha = encoded_alpha as f64 / 255.0;
            assert_pixel(&page, 20, 20, effective_image_expectation(decoded_alpha, ais), "intrinsic SMask replaces host Alpha");
            assert_eq!(guard_count(&page), 0, "intrinsic image certificate RED/green boundary: {:?}", page.warnings);
        }
    }
}

#[test]
fn image_smask_wins_explicit_mask_and_zero_alpha_still_has_shape() {
    for ais in [false, true] {
        let page = render(&image_scene(Some(0), Some(255), None, ais));
        assert_pixel(&page, 20, 20, effective_image_expectation(0., ais), "image /SMask takes precedence over /Mask");
        assert_eq!(guard_count(&page), 0, "mask precedence certificate RED/green boundary: {:?}", page.warnings);
    }
}

#[test]
fn debug_mask_fixture_renders_sibling_before_image() {
    let mut doc = Document::with_version("1.7");
    let image = cmyk_image(&mut doc, None, None);
    let group = form(&mut doc,
        "0 1 0 0 k 4 4 32 32 re f q 16 0 0 16 12 12 cm /Im Do Q",
        dictionary! { "XObject" => dictionary! { "Im" => image } }, false, true);
    let contents = doc.add_object(Stream::new(dictionary! {}, b"0.2 0.4 0.6 0.3 k 0 0 40 40 re f /Outer Do".to_vec()));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => contents,
        "Resources" => dictionary! { "XObject" => dictionary! { "Outer" => group } },
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
    });
    doc.set_object(pages, dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    let page = render(&doc);
    eprintln!("debug center={:?} outside={:?} warnings={:?}", pixel(&page,20,20), pixel(&page,7,20), page.warnings);
    assert_pixel(&page, 7, 20, SIBLING, "sibling before image");
}

#[test]
fn debug_intrinsic_without_host_changes_center() {
    let mut doc = Document::with_version("1.7");
    let intrinsic = image_mask(&mut doc, 0, 1, 1);
    let image = cmyk_image(&mut doc, Some(intrinsic), None);
    let group = form(&mut doc,
        "0 1 0 0 k 4 4 32 32 re f q 16 0 0 16 12 12 cm /Im Do Q",
        dictionary! { "XObject" => dictionary! { "Im" => image } }, false, true);
    let contents = doc.add_object(Stream::new(dictionary! {}, b"0.2 0.4 0.6 0.3 k 0 0 40 40 re f /Outer Do".to_vec()));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => contents,
        "Resources" => dictionary! { "XObject" => dictionary! { "Outer" => group } },
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
    });
    doc.set_object(pages, dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    let page = render(&doc);
    eprintln!("intrinsic-only center={:?} outside={:?} warnings={:?}", pixel(&page,20,20), pixel(&page,7,20), page.warnings);
    assert_pixel(&page,20,20,[0.2,0.4,0.6,0.3],"intrinsic alpha0 shape");
}

