//! CORRECTNESS (audit 2026-09-28 §KNOCK.BBOX): một BBox hình học chỉ giao một lần.
//! Oracle là cùng nội dung với đúng một clip, không đổi phép nhân clip tổng quát.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, render_page_managed_region, PageBox, PageRender, RasterClip};

const PAGE: i64 = 32;
const BBOX: [f32; 4] = [3.25, 4.25, 24.75, 25.75];
const PAINT: &str = "0 0 0 1 k -100 -100 200 200 re f";

fn numbers(values: impl IntoIterator<Item = f32>) -> Object {
    Object::Array(values.into_iter().map(Object::Real).collect())
}

fn form(
    doc: &mut Document,
    content: &str,
    bbox: [f32; 4],
    matrix: Option<[f32; 6]>,
    group: Option<bool>,
    resources: Dictionary,
) -> Object {
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "BBox" => numbers(bbox),
        "Resources" => resources,
    };
    if let Some(matrix) = matrix {
        dict.set("Matrix", numbers(matrix));
    }
    if let Some(knockout) = group {
        dict.set("Group", dictionary! {
            "S" => "Transparency", "CS" => "DeviceCMYK", "I" => false, "K" => knockout,
        });
    }
    Object::Reference(doc.add_object(Stream::new(dict, content.as_bytes().to_vec())))
}

fn document(content: &str, resources: impl FnOnce(&mut Document) -> Dictionary) -> Document {
    let mut doc = Document::with_version("1.7");
    let resources = resources(&mut doc);
    let contents = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
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

fn nested(
    outer_group: Option<bool>,
    inner_group: Option<bool>,
    body: &str,
    inner_bbox: [f32; 4],
    inner_matrix: Option<[f32; 6]>,
) -> Document {
    document("/Outer Do", |doc| {
        let inner = form(doc, PAINT, inner_bbox, inner_matrix, inner_group, dictionary! {});
        let outer = form(doc, body, BBOX, None, outer_group, dictionary! {
            "XObject" => dictionary! { "Inner" => inner },
            "ExtGState" => dictionary! { "Half" => dictionary! { "ca" => 0.5, "CA" => 0.5 } },
        });
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    })
}

fn render(doc: &Document, anti_alias: bool) -> PageRender {
    let mut opts = RenderOptions::default();
    opts.anti_alias = anti_alias;
    render_page(doc, 1, 72., PageBox::Crop, opts).unwrap()
}

fn assert_same(actual: &PageRender, expected: &PageRender, context: &str) {
    assert_eq!(actual.buffer.width(), expected.buffer.width());
    assert_eq!(actual.buffer.height(), expected.buffer.height());
    for channel in 0..4 {
        for (index, (actual, expected)) in actual.buffer.plane(channel).iter()
            .zip(expected.buffer.plane(channel)).enumerate()
        {
            assert!((actual - expected).abs() <= 1e-6,
                "{context}: kênh{channel},pixel{index}: nhận{actual},muốn{expected}");
        }
    }
}

#[test]
fn duplicate_fractional_bbox_is_idempotent_for_forms_non_knockout_and_knockout_groups() {
    for aa in [false, true] {
        for outer in [None, Some(false), Some(true)] {
            for inner in [None, Some(false), Some(true)] {
                let once = render(&nested(outer, inner, PAINT, BBOX, None), aa);
                let twice = render(&nested(outer, inner, "/Inner Do", BBOX, None), aa);
                assert_same(&twice, &once, &format!("AA={aa},outer={outer:?},inner={inner:?}"));
                if outer == Some(true) || inner == Some(true) {
                    assert!(twice.warnings.unsupported_transparency,
                        "Sửa BBox không được mở chứng nhận K");
                }
            }
        }
    }
}

#[test]
fn duplicate_bbox_does_not_reapply_coverage_to_group_opacity() {
    for group in [Some(false), Some(true)] {
        let once = render(&nested(None, group, &format!("/Half gs {PAINT}"), BBOX, None), true);
        let twice = render(&nested(None, group, "/Half gs /Inner Do", BBOX, None), true);
        assert_same(&twice, &once, "Opacity group nhân đúng một lần, BBox không nhân lại");
    }
}

#[test]
fn duplicate_bbox_preserves_new_manual_clip_and_empty_clip() {
    for clipping in ["8.25 0 8.5 32 re W n", "W n"] {
        let once = render(&nested(None, None, &format!("{clipping} {PAINT}"), BBOX, None), true);
        let twice = render(&nested(None, None, &format!("{clipping} /Inner Do"), BBOX, None), true);
        assert_same(&twice, &once, "Gặp BBox cũ vẫn phải giữ clip mới chặt hơn");
    }
}

#[test]
fn an_older_duplicate_bbox_does_not_discard_an_intervening_bbox() {
    for duplicate in [false, true] {
        let doc = document("/Outer Do", |doc| {
            let inner = form(doc, PAINT, BBOX, None, None, dictionary! {});
            let middle = form(doc, if duplicate { "/Inner Do" } else { PAINT },
                [8.25, 6.25, 16.75, 23.75], None, None,
                dictionary! { "XObject" => dictionary! { "Inner" => inner } });
            let outer = form(doc, "/Middle Do", BBOX, None, None,
                dictionary! { "XObject" => dictionary! { "Middle" => middle } });
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        let actual = render(&doc, true);
        let expected = render(&nested(None, None,
            &format!("8.25 6.25 8.5 17.5 re W n {PAINT}"), BBOX, None), true);
        assert_same(&actual, &expected, "A rồi B rồi A vẫn giữ A giao B, không thay bằng mask A");
    }
}

#[test]
fn antialiased_strokes_keep_the_same_bbox_coverage_through_nested_groups() {
    let stroke = "0.48 0.125 0 0 K 0.6 w 3.625 0 m 3.625 32 l S";
    for inner_group in [None, Some(false), Some(true)] {
        let doc = document("/Outer Do", |doc| {
            let inner = form(doc, stroke, BBOX, None, inner_group, dictionary! {});
            let outer = form(doc, "/Inner Do", BBOX, None, Some(false),
                dictionary! { "XObject" => dictionary! { "Inner" => inner } });
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        let once = render(&nested(Some(false), None, stroke, BBOX, None), true);
        let actual = render(&doc, true);
        assert_same(&actual, &once, "Nét AA sát BBox không bị làm nhạt bởi group lồng");
    }
}

#[test]
fn graphics_state_restore_does_not_leak_bbox_history_into_the_next_form() {
    let doc = document("q 1 0 0 0 k /A Do Q q 0 1 0 0 k /A Do Q", |doc| {
        let inner = form(doc, "-100 -100 200 200 re f", BBOX, None, None, dictionary! {});
        let outer = form(doc, "/Inner Do", BBOX, None, None,
            dictionary! { "XObject" => dictionary! { "Inner" => inner } });
        dictionary! { "XObject" => dictionary! { "A" => outer } }
    });
    let page = render(&doc, true);
    assert_eq!(page.buffer.plane(1)[0], 0., "Q phải trả lại lịch sử clip của caller");
    assert_eq!(page.buffer.plane(1)[16 * PAGE as usize + 16], 1.);
}

#[test]
fn changed_ctm_is_not_deduplicated_by_user_space_bbox() {
    let matrix = Some([1., 0., 0., 1., 4.5, 0.]);
    let once = render(&nested(None, None,
        &format!("q 1 0 0 1 4.5 0 cm 3.25 4.25 21.5 21.5 re W n {PAINT} Q"), BBOX, None), true);
    let nested = render(&nested(None, None, "/Inner Do", BBOX, matrix), true);
    assert_same(&nested, &once, "BBox giống trong user space nhưng CTM khác phải giao clip mới");
}

#[test]
fn equal_device_geometry_is_deduplicated_even_when_bbox_and_ctm_differ() {
    let once = render(&nested(None, None, PAINT, BBOX, None), true);
    let twice = render(&nested(None, None, "/Inner Do", [-6.75, 4.25, 14.75, 25.75],
        Some([1., 0., 0., 1., 10., 0.])), true);
    assert_same(&twice, &once, "Khóa dùng hình học thiết bị, không dùng nguồn BBox/CTM");
}

#[test]
fn equal_aabb_is_not_equal_bbox_geometry() {
    let doc = document("/Outer Do", |doc| {
        let inner = form(doc, PAINT, [0., 0., 10., 10.], Some([1., 1., -1., 1., 16., 6.]),
            None, dictionary! {});
        let outer = form(doc, "/Inner Do", [6., 6., 26., 26.], None, None,
            dictionary! { "XObject" => dictionary! { "Inner" => inner } });
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    let page = render(&doc, true);
    assert_eq!(page.buffer.plane(3)[8 * PAGE as usize + 7], 0.,
        "Hình thoi và vuông cùng AABB nhưng khác clip");
    assert_eq!(page.buffer.plane(3)[16 * PAGE as usize + 16], 1.);
}

#[test]
fn viewport_keeps_duplicate_bbox_in_the_same_device_space() {
    let doc = nested(Some(false), Some(true), "/Inner Do", BBOX, None);
    let full = render(&doc, true);
    let clip = RasterClip { x: 2, y: 2, width: 26, height: 26 };
    let cropped = render_page_managed_region(&doc, 1, 72., PageBox::Crop,
        RenderOptions::default(), None, Some(clip)).unwrap();
    for channel in 0..4 {
        for y in 0..clip.height as usize {
            for x in 0..clip.width as usize {
                let actual = cropped.buffer.plane(channel)[y * clip.width as usize + x];
                let expected = full.buffer.plane(channel)[(y + clip.y as usize) * PAGE as usize + x + clip.x as usize];
                assert!((actual - expected).abs() <= 1e-6,
                    "Tile không nhận nhầm BBox toàn trang tại({x},{y}),kênh{channel}");
            }
        }
    }
    let once = render_page_managed_region(&nested(Some(false), None, PAINT, BBOX, None),
        1, 72., PageBox::Crop, RenderOptions::default(), None, Some(clip)).unwrap();
    assert_same(&cropped, &once, "Duplicate BBox trong viewport vẫn là một clip");
}
