//! Hồi quy appearance stream `/AP` của annotation/widget trong Viewer.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 40;

fn appearance(content: &str) -> Stream {
    Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 2.into(), 2.into()],
            "Resources" => Dictionary::new(),
        },
        content.as_bytes().to_vec(),
    )
}

fn document_with_annotation(
    mut doc: Document,
    annotation: Dictionary,
    acro_form: Option<Dictionary>,
) -> Document {
    let annotation_id = doc.add_object(annotation);
    let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Annots" => vec![Object::Reference(annotation_id)],
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        },
    );
    let mut catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    };
    if let Some(form) = acro_form {
        catalog.set("AcroForm", Object::Dictionary(form));
    }
    let catalog_id = doc.add_object(catalog);
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

fn render(doc: &Document, annotations: bool) -> PageRender {
    render_page(
        doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_annotations(annotations),
    )
    .expect("fixture annotation phải render được")
}

fn k_at(rendered: &PageRender, x: usize, y: usize) -> u8 {
    rendered.buffer.plate_u8(3)[y * rendered.buffer.width() as usize + x]
}

#[test]
fn normal_appearance_is_mapped_into_annotation_rect() {
    let mut doc = Document::with_version("1.7");
    let ap_id = doc.add_object(appearance("0 0 0 1 k 0 0 2 2 re f"));
    let annotation = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Stamp",
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
        "AP" => dictionary! { "N" => Object::Reference(ap_id) },
    };
    let doc = document_with_annotation(doc, annotation, None);

    let hidden = render(&doc, false);
    let shown = render(&doc, true);
    assert_eq!(
        k_at(&hidden, 20, 20),
        0,
        "đường đo mặc định không dựng annotation"
    );
    assert_eq!(k_at(&shown, 20, 20), 255, "tâm /Rect phải nhận appearance");
    assert_eq!(
        k_at(&shown, 5, 20),
        0,
        "appearance không được tràn ngoài /Rect"
    );
    assert!(!shown.warnings.degrades_accuracy());
}

#[test]
fn appearance_matrix_is_normalized_before_fitting_rect() {
    let mut doc = Document::with_version("1.7");
    let ap_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 2.into(), 2.into()],
            "Matrix" => vec![2.into(), 0.into(), 0.into(), 2.into(), 5.into(), 7.into()],
        },
        b"0 0 0 1 k 0 0 2 2 re f".to_vec(),
    ));
    let annotation = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Stamp",
        "Rect" => vec![8.into(), 12.into(), 28.into(), 32.into()],
        "AP" => dictionary! { "N" => Object::Reference(ap_id) },
    };
    let rendered = render(&document_with_annotation(doc, annotation, None), true);
    assert_eq!(k_at(&rendered, 18, 18), 255);
    assert_eq!(k_at(&rendered, 4, 18), 0);
}

#[test]
fn widget_uses_the_named_normal_appearance_state() {
    let mut doc = Document::with_version("1.7");
    let off = doc.add_object(appearance(""));
    let yes = doc.add_object(appearance("0 0 0 1 k 0 0 2 2 re f"));
    let annotation = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Widget",
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
        "AS" => "Yes",
        "AP" => dictionary! {
            "N" => dictionary! {
                "Off" => Object::Reference(off),
                "Yes" => Object::Reference(yes),
            }
        },
    };
    let rendered = render(&document_with_annotation(doc, annotation, None), true);
    assert_eq!(k_at(&rendered, 20, 20), 255);
    assert!(!rendered.warnings.degrades_accuracy());
}

#[test]
fn hidden_or_no_view_annotation_is_skipped_without_degrading() {
    let mut doc = Document::with_version("1.7");
    let ap_id = doc.add_object(appearance("0 0 0 1 k 0 0 2 2 re f"));
    let annotation = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Stamp",
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
        "F" => 32,
        "AP" => dictionary! { "N" => Object::Reference(ap_id) },
    };
    let rendered = render(&document_with_annotation(doc, annotation, None), true);
    assert_eq!(k_at(&rendered, 20, 20), 0);
    assert!(!rendered.warnings.degrades_accuracy());
}

#[test]
fn widget_without_appearance_and_xfa_fail_loud() {
    let doc = Document::with_version("1.7");
    let annotation = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Widget",
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
    };
    let rendered = render(
        &document_with_annotation(
            doc,
            annotation,
            Some(
                dictionary! { "XFA" => Object::String(b"dynamic".to_vec(), lopdf::StringFormat::Literal) },
            ),
        ),
        true,
    );
    assert!(rendered.warnings.ink_unsound());
    assert!(rendered.warnings.dropped_objects >= 2);
    assert!(rendered
        .warnings
        .skipped_ops
        .iter()
        .any(|(name, _)| name.contains("XFA")));
}
