//! Regression semantic cho font Type3 (`d0`/`d1`) và boundary graphics-state.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 100;
const GLYPH_PIXELS: usize = 80 * 80;
const STATE_DEPTH_OVERFLOW_REASON: &str = "q (vượt trần graphics-state)";

fn add_coloured_pattern(doc: &mut Document, cell: &[u8]) -> lopdf::ObjectId {
    doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 1000.into(), 1000.into()],
            "XStep" => 1000,
            "YStep" => 1000,
            "Resources" => dictionary! {},
        },
        cell.to_vec(),
    ))
}

fn type3_document(char_proc: &str, page_content: String, with_patterns: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let (font_resources, page_patterns) = if with_patterns {
        let caller = add_coloured_pattern(&mut doc, b"0 0 0 1 k 0 0 1000 1000 re f");
        let inner = add_coloured_pattern(&mut doc, b"1 0 1 0 k 0 0 1000 1000 re f");
        let patterns = dictionary! {
            "PCaller" => Object::Reference(caller),
            "PInner" => Object::Reference(inner),
        };
        (
            dictionary! { "Pattern" => Object::Dictionary(patterns.clone()) },
            Some(patterns),
        )
    } else {
        (Dictionary::new(), None)
    };

    let char_proc_id = doc.add_object(Stream::new(dictionary! {}, char_proc.as_bytes().to_vec()));
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type3",
        "Name" => "F0",
        "FontBBox" => vec![0.into(), 0.into(), 1000.into(), 1000.into()],
        "FontMatrix" => vec![
            Object::Real(0.001), 0.into(), 0.into(), Object::Real(0.001), 0.into(), 0.into(),
        ],
        "CharProcs" => dictionary! { "A" => Object::Reference(char_proc_id) },
        "Encoding" => dictionary! {
            "Type" => "Encoding",
            "Differences" => vec![65.into(), Object::Name(b"A".to_vec())],
        },
        "FirstChar" => 65,
        "LastChar" => 65,
        "Widths" => vec![1000.into()],
        "Resources" => Object::Dictionary(font_resources),
    });

    let mut resources = dictionary! {
        "Font" => dictionary! { "F0" => Object::Reference(font_id) },
    };
    if let Some(patterns) = page_patterns {
        resources.set("Pattern", Object::Dictionary(patterns));
    }
    let resources_id = doc.add_object(resources);
    let content_id = doc.add_object(Stream::new(dictionary! {}, page_content.into_bytes()));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

fn text_at_80pt(prefix: &str) -> String {
    format!("{prefix} BT /F0 80 Tf 1 0 0 1 10 10 Tm (A) Tj ET")
}

fn render(doc: &Document) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("Type3 synthetic phải render được")
}

fn full_ink_pixels(rendered: &PageRender, channel: usize) -> usize {
    rendered
        .buffer
        .plate_u8(channel)
        .iter()
        .filter(|value| **value == 255)
        .count()
}

fn warning_count(rendered: &PageRender, reason: &str) -> u32 {
    rendered
        .warnings
        .skipped_ops
        .iter()
        .find(|(current, _)| current == reason)
        .map_or(0, |(_, count)| *count)
}

#[test]
fn type3_d1_uses_caller_k_for_all_6400_pixels() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A06): d1 cấm cả color operator trực
    // tiếp, resolve cs/CS và scn/SCN. Glyph phải giữ màu K của caller.
    let char_proc = concat!(
        "1000 0 0 0 1000 1000 d1 ",
        "0 g 0 G 0 1 0 rg 0 1 0 RG 1 0 1 0 k 1 0 1 0 K ",
        "/Missing cs /Missing CS 1 0 1 0 sc 1 0 1 0 SC ",
        "1 0 1 0 scn 1 0 1 0 SCN 0 0 1000 1000 re f"
    );
    let rendered = render(&type3_document(char_proc, text_at_80pt("0 0 0 1 k"), false));

    let counts = [0, 1, 2, 3].map(|channel| full_ink_pixels(&rendered, channel));
    assert_eq!(counts[3], GLYPH_PIXELS, "CMYK full-pixel counts={counts:?}");
    assert_eq!(counts[0], 0, "CMYK full-pixel counts={counts:?}");
    assert_eq!(counts[1], 0, "CMYK full-pixel counts={counts:?}");
    assert_eq!(counts[2], 0, "CMYK full-pixel counts={counts:?}");
    assert!(
        rendered.warnings.approximated_colorspaces.is_empty(),
        "cs/CS trong d1 không được resolve: {:?}",
        rendered.warnings
    );
}

#[test]
fn type3_d1_cannot_replace_caller_pattern_selection() {
    // Guard trong set_components là chưa đủ: scn/SCN từng gán tên Pattern trực
    // tiếp. Caller K phải thắng Pattern xanh mà CharProc cố chọn.
    let char_proc = concat!(
        "1000 0 0 0 1000 1000 d1 ",
        "/PInner scn /PInner SCN 0 0 1000 1000 re f"
    );
    let caller = "/Pattern cs /PCaller scn /Pattern CS /PCaller SCN";
    let rendered = render(&type3_document(char_proc, text_at_80pt(caller), true));

    let counts = [0, 1, 2, 3].map(|channel| full_ink_pixels(&rendered, channel));
    assert_eq!(counts[3], GLYPH_PIXELS, "CMYK full-pixel counts={counts:?}");
    assert_eq!(counts[0], 0, "CMYK full-pixel counts={counts:?}");
    assert_eq!(counts[2], 0, "CMYK full-pixel counts={counts:?}");
}

#[test]
fn type3_d0_keeps_internal_green_for_all_6400_pixels() {
    let char_proc = "1000 0 d0 0 1 0 rg 0 0 1000 1000 re f";
    let rendered = render(&type3_document(char_proc, text_at_80pt("0 0 0 1 k"), false));

    assert_eq!(full_ink_pixels(&rendered, 0), GLYPH_PIXELS);
    assert_eq!(full_ink_pixels(&rendered, 2), GLYPH_PIXELS);
    assert_eq!(full_ink_pixels(&rendered, 1), 0);
    assert_eq!(full_ink_pixels(&rendered, 3), 0);
}

#[test]
fn type3_internal_save_overflow_is_contained() {
    let mut page = "q ".repeat(255);
    page.push_str("0 0 0 1 k BT /F0 80 Tf 1 0 0 1 10 10 Tm (A) Tj ET ");
    page.push_str(&"Q ".repeat(255));
    page.push_str("0 0 0 1 k 80 80 20 20 re f");
    let doc = type3_document("1000 0 d0 0 0 0 1 k 0 0 1000 1000 re f", page, false);
    let rendered = render(&doc);

    assert_eq!(full_ink_pixels(&rendered, 3), 400,);
    assert_eq!(warning_count(&rendered, STATE_DEPTH_OVERFLOW_REASON), 1);
    assert_eq!(warning_count(&rendered, "Q (không cân)"), 0);
    assert_eq!(rendered.warnings.dropped_objects, 1);
}
