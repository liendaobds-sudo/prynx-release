//! Regression tích hợp cho quy tắc chọn hộp trang PDF.

use lopdf::{dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::geom::Rect;
use print_engine::page::{render_page, PageBox, PageRender};

const MEDIA: [f32; 4] = [0.0, 0.0, 100.0, 100.0];

fn pdf_rect(values: [f32; 4]) -> Vec<Object> {
    values.into_iter().map(Object::Real).collect()
}

fn build_pdf(boxes: &[(&str, [f32; 4])]) -> Document {
    let mut doc = Document::with_version("1.7");
    let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
    let pages_id = doc.new_object_id();

    let mut page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "MediaBox" => pdf_rect(MEDIA),
    };
    for (key, value) in boxes {
        page.set(*key, pdf_rect(*value));
    }
    let page_id = doc.add_object(page);

    doc.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

fn render(doc: &Document, which: PageBox) -> PageRender {
    render_page(doc, 1, 72.0, which, RenderOptions::ink_accurate())
        .expect("PDF hộp trang synthetic phải render được")
}

fn assert_target(rendered: &PageRender, expected: [f32; 4]) {
    let expected = Rect::new(expected[0], expected[1], expected[2], expected[3]);
    assert_eq!(rendered.box_used, expected);
    assert_eq!(
        (rendered.buffer.width(), rendered.buffer.height()),
        (expected.width() as u32, expected.height() as u32),
        "72 DPI phải ánh xạ một point thành một pixel"
    );
}

#[test]
fn media_box_is_used_verbatim_instead_of_crop() {
    let doc = build_pdf(&[("CropBox", [20.0, 20.0, 80.0, 80.0])]);
    assert_target(&render(&doc, PageBox::Media), MEDIA);
}

#[test]
fn crop_box_is_intersected_with_media_or_falls_back_to_media() {
    let partly_outside = build_pdf(&[("CropBox", [-10.0, 15.0, 80.0, 120.0])]);
    assert_target(
        &render(&partly_outside, PageBox::Crop),
        [0.0, 15.0, 80.0, 100.0],
    );

    let disjoint = build_pdf(&[("CropBox", [120.0, 120.0, 140.0, 140.0])]);
    assert_target(&render(&disjoint, PageBox::Crop), MEDIA);
}

#[test]
fn missing_trim_bleed_and_art_fall_back_to_effective_crop() {
    let crop = [20.0, 10.0, 80.0, 90.0];
    let doc = build_pdf(&[("CropBox", crop)]);

    for which in [PageBox::Trim, PageBox::Bleed, PageBox::Art] {
        assert_target(&render(&doc, which), crop);
    }
}

#[test]
fn declared_trim_bleed_and_art_are_not_clamped_to_crop() {
    let selected = [-10.0, 5.0, 95.0, 110.0];
    let doc = build_pdf(&[
        ("CropBox", [20.0, 20.0, 80.0, 80.0]),
        ("TrimBox", selected),
        ("BleedBox", selected),
        ("ArtBox", selected),
    ]);
    let expected_media_intersection = [0.0, 5.0, 95.0, 100.0];

    for which in [PageBox::Trim, PageBox::Bleed, PageBox::Art] {
        assert_target(&render(&doc, which), expected_media_intersection);
    }
}

#[test]
fn disjoint_trim_bleed_and_art_fall_back_to_effective_crop() {
    let declared_crop = [-20.0, 10.0, 70.0, 120.0];
    let doc = build_pdf(&[
        ("CropBox", declared_crop),
        ("TrimBox", [120.0, 120.0, 140.0, 140.0]),
        ("BleedBox", [120.0, 120.0, 140.0, 140.0]),
        ("ArtBox", [120.0, 120.0, 140.0, 140.0]),
    ]);
    let effective_crop = [0.0, 10.0, 70.0, 100.0];

    for which in [PageBox::Trim, PageBox::Bleed, PageBox::Art] {
        assert_target(&render(&doc, which), effective_crop);
    }
}
