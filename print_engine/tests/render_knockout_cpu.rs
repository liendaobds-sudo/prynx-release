//! QUALITY (audit 2026-09-28 §KNOCK.C1): số học knockout CPU độc lập với PPE.
//!
//! Oracle: ISO 32000-1:2008 §11.4.6 và §11.6.4.2–4 (Adobe). Mỗi phần tử
//! K=true pha với backdrop ban đầu; shape mới quyết định xoá phần tử trước.
//! AIS=false: hằng alpha là opacity; AIS=true: hằng alpha là shape.
//! https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf
//!
//! C1 sửa nền số học; lô C2b mở chứng nhận có điều kiện cho ảnh process và
//! vector process trong preview. Đo/xuất mực và các primitive ngoài miền vẫn
//! phải giữ guard; không thay golden hoặc gỡ guard bằng test.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::geom::Region;
use print_engine::ink::ChannelMask;
use print_engine::page::{
    render_page, render_page_managed_region, PageBox, PageRender, RasterClip,
};
use print_engine::{InkBuffer, InkPaint, InkSpace, PpeError};

const PAGE: i64 = 40;

fn document(content: &str, resources: impl FnOnce(&mut Document) -> Dictionary) -> Document {
    let mut doc = Document::with_version("1.7");
    let resources = resources(&mut doc);
    let stream = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => stream,
        "Resources" => resources,
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK", "I" => true },
    });
    doc.set_object(
        pages,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 },
    );
    let root = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", root);
    doc
}

fn form(
    doc: &mut Document,
    content: &str,
    resources: Dictionary,
    isolated: bool,
    knockout: bool,
) -> Object {
    Object::Reference(doc.add_object(Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Form",
        "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        "Resources" => resources,
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK", "I" => isolated, "K" => knockout },
    }, content.as_bytes().to_vec())))
}

fn render(doc: &Document) -> PageRender {
    render_page(doc, 1, 72., PageBox::Crop, RenderOptions::ink_accurate())
        .expect("Fixture knockout phải dựng được pixel cùng cảnh báo trung thực")
}

fn assert_ink(page: &PageRender, x: usize, y: usize, expected: [f32; 4], context: &str) {
    let index = y * page.buffer.width() as usize + x;
    for (channel, wanted) in expected.into_iter().enumerate() {
        let actual = page.buffer.plane(channel)[index];
        assert!(
            (actual - wanted).abs() <= 2e-6,
            "{context}: kênh {channel} tại ({x},{y}) phải là {wanted}, nhận {actual}"
        );
    }
}

fn paint(ink: [f32; 4], alpha: f32) -> InkPaint {
    let mut result = InkPaint::opaque(ink.to_vec(), ChannelMask::PROCESS);
    result.alpha = alpha;
    result
}

fn assert_buffer(buffer: &InkBuffer, index: usize, expected: [f32; 4]) {
    for (channel, expected) in expected.into_iter().enumerate() {
        assert!(
            (buffer.plane(channel)[index] - expected).abs() <= 2e-6,
            "Pixel {index} kênh {channel}: muốn {expected}, nhận {}",
            buffer.plane(channel)[index]
        );
    }
}

fn assert_c1_guard(page: &PageRender) {
    assert!(
        page.warnings.unsupported_transparency,
        "C1 chưa được gắn color-verified cho cả nhóm K: {:?}",
        page.warnings
    );
    assert!(page.warnings.ink_unsound());
    assert!(
        page.warnings
            .skipped_ops
            .iter()
            .any(|(label, _)| label.contains("knockout")),
        "Phải giữ lý do knockout rõ ràng: {:?}",
        page.warnings.skipped_ops
    );
}

fn assert_preview_certificate(page: &PageRender) {
    assert_eq!(
        page.warnings
            .skipped_ops
            .iter()
            .filter(|(label, _)| label.contains("knockout"))
            .map(|(_, count)| *count)
            .sum::<u32>(),
        0,
        "Preview C2b không được giữ guard knockout: {:?}",
        page.warnings
    );
    assert!(!page.warnings.unsupported_transparency,
        "Preview C2b ảnh process phải sạch cảnh báo transparency: {:?}", page.warnings);
}

fn two_objects(isolated: bool, knockout: bool, ais: bool, alpha: f32, stroke: bool) -> Document {
    document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
        let second = if stroke {
            "0 0 0 1 K 8 w 20 12 m 20 28 l S"
        } else {
            "0 0 0 1 k 12 12 16 16 re f"
        };
        let content = format!("0 1 0 0 k 4 4 32 32 re f /A gs {second}");
        // Stroke phải đọc CA riêng; ca=0 bắt lỗi vô tình dùng alpha tô cho nét.
        let fill_alpha = if stroke { 0.0 } else { alpha };
        let group = form(
            doc,
            &content,
            dictionary! {
                "ExtGState" => dictionary! { "A" => dictionary! { "ca" => fill_alpha, "CA" => alpha, "AIS" => ais } },
            },
            isolated,
            knockout,
        );
        dictionary! { "XObject" => dictionary! { "Outer" => group } }
    })
}

#[test]
fn binary_knockout_uses_initial_backdrop_not_previous_sibling() {
    for isolated in [false, true] {
        for alpha in [0., 0.5, 1.] {
            let page = render(&two_objects(isolated, true, false, alpha, false));
            // Shape=1 xóa M trước đó; nguồn K opacity=a nằm trên backdrop C.
            assert_ink(
                &page,
                20,
                20,
                [1. - alpha, 0., 0., alpha],
                "K=true AIS=false",
            );
            assert_ink(&page, 7, 20, [0., 1., 0., 0.], "Ngoài shape mới giữ M cũ");
            assert_ink(&page, 1, 20, [1., 0., 0., 0.], "Ngoài group giữ backdrop C");
            assert_c1_guard(&page);
        }
    }
}

#[test]
fn ais_changes_constant_alpha_from_opacity_to_knockout_shape() {
    for isolated in [false, true] {
        for alpha in [0., 0.5, 1.] {
            let page = render(&two_objects(isolated, true, true, alpha, false));
            // Opacity=1 nhưng shape=a chỉ xoá tỷ lệ a của M trước đó.
            assert_ink(
                &page,
                20,
                20,
                [0., 1. - alpha, 0., alpha],
                "K=true AIS=true",
            );
            assert_c1_guard(&page);
        }
    }
}

#[test]
fn non_knockout_normal_composites_both_ais_modes_with_immediate_backdrop() {
    for isolated in [false, true] {
        for ais in [false, true] {
            for alpha in [0., 0.5, 1.] {
                let page = render(&two_objects(isolated, false, ais, alpha, false));
                assert_ink(
                    &page,
                    20,
                    20,
                    [0., 1. - alpha, 0., alpha],
                    "K=false giữ compositing thường",
                );
                assert!(
                    !page.warnings.unsupported_transparency,
                    "{:?}",
                    page.warnings
                );
            }
        }
    }
}

#[test]
fn stroke_uses_ca_and_ais_as_shape_or_opacity_without_erasing_its_bbox() {
    for isolated in [false, true] {
        for ais in [false, true] {
            for alpha in [0., 0.5, 1.] {
                let page = render(&two_objects(isolated, true, ais, alpha, true));
                let expected = if ais {
                    [0., 1. - alpha, 0., alpha]
                } else {
                    [1. - alpha, 0., 0., alpha]
                };
                assert_ink(&page, 20, 20, expected, "Stroke giữa nét");
                assert_ink(&page, 10, 20, [0., 1., 0., 0.], "Ngoài nét không khoét M");
                assert_c1_guard(&page);
            }
        }
    }
}

#[test]
fn outer_group_opacity_applies_once_after_knockout() {
    for isolated in [false, true] {
        let doc = document("1 0 0 0 k 0 0 40 40 re f /Fade gs /Outer Do", |doc| {
            let group = form(
                doc,
                "0 1 0 0 k 4 4 32 32 re f /Half gs 0 0 0 1 k 12 12 16 16 re f",
                dictionary! { "ExtGState" => dictionary! { "Half" => dictionary! { "ca" => 0.5 } } },
                isolated,
                true,
            );
            dictionary! {
                "XObject" => dictionary! { "Outer" => group },
                "ExtGState" => dictionary! { "Fade" => dictionary! { "ca" => 0.5 } },
            }
        });
        let page = render(&doc);
        // K .5 trong group × group .5 = .25, backdrop C còn .75. M bị khoét.
        assert_ink(
            &page,
            20,
            20,
            [0.75, 0., 0., 0.25],
            "Group alpha chỉ nhân một lần",
        );
        assert_ink(
            &page,
            7,
            20,
            [0.5, 0.5, 0., 0.],
            "Ngoài hình K còn M nửa opacity",
        );
        assert_c1_guard(&page);
    }
}

#[test]
fn nested_non_knockout_group_is_one_object_and_uses_outer_initial_backdrop() {
    for outer_isolated in [false, true] {
        for inner_isolated in [false, true] {
            let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                let inner = form(
                    doc,
                    "/Half gs 0 1 0 0 k 8 8 24 24 re f 0 0 0 1 k 12 12 16 16 re f",
                    dictionary! { "ExtGState" => dictionary! { "Half" => dictionary! { "ca" => 0.5 } } },
                    inner_isolated,
                    false,
                );
                let outer = form(
                    doc,
                    "0 0 1 0 k 4 4 32 32 re f /Inner Do",
                    dictionary! { "XObject" => dictionary! { "Inner" => inner } },
                    outer_isolated,
                    true,
                );
                dictionary! { "XObject" => dictionary! { "Outer" => outer } }
            });
            let page = render(&doc);
            // Hai con non-K: M .5 rồi K .5 => M .25 + K .5 + C .25.
            // Y là sibling của cả group, bị shape group khoét, không làm backdrop con.
            assert_ink(
                &page,
                20,
                20,
                [0.25, 0.25, 0., 0.5],
                "Group non-K bên trong K",
            );
            assert_ink(
                &page,
                10,
                20,
                [0.5, 0.5, 0., 0.],
                "Chỉ phủ hình M bên trong",
            );
            assert_ink(
                &page,
                6,
                20,
                [0., 0., 1., 0.],
                "Ngoài shape group con giữ Y",
            );
            assert_c1_guard(&page);
        }
    }
}

#[test]
fn nested_knockout_group_keeps_shape_when_last_child_has_zero_opacity() {
    for inner_isolated in [false, true] {
        let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
            let inner = form(
                doc,
                "0 1 0 0 k 8 8 24 24 re f /Zero gs 0 0 0 1 k 12 12 16 16 re f",
                dictionary! { "ExtGState" => dictionary! { "Zero" => dictionary! { "ca" => 0. } } },
                inner_isolated,
                true,
            );
            let outer = form(
                doc,
                "0 0 1 0 k 4 4 32 32 re f /Inner Do",
                dictionary! { "XObject" => dictionary! { "Inner" => inner } },
                false,
                true,
            );
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        let page = render(&doc);
        assert_ink(
            &page,
            20,
            20,
            [1., 0., 0., 0.],
            "Shape khác alpha: group trong suốt vẫn khoét Y",
        );
        assert_ink(
            &page,
            10,
            20,
            [0., 1., 0., 0.],
            "Vùng M không bị con alpha0 phủ",
        );
        assert_c1_guard(&page);
    }
}

#[test]
fn zero_opacity_non_knockout_child_still_erases_parent_sibling_unless_ais_is_shape() {
    for child_isolated in [false, true] {
        for outer_ais in [false, true] {
            for constant_at_group in [false, true] {
                let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                    // Con không-K vẫn phải lưu shape=1 dù GA=0. Ca group ở
                    // parent quyết định shape có bị nhân0 hay chỉ opacity bị0.
                    let state = dictionary! { "ExtGState" => dictionary! {
                        "Zero" => dictionary! { "ca" => 0., "AIS" => outer_ais },
                    } };
                    let child_content = if constant_at_group {
                        "0 0 0 1 k 12 12 16 16 re f"
                    } else {
                        "/Zero gs 0 0 0 1 k 12 12 16 16 re f"
                    };
                    let child = form(doc, child_content, state, child_isolated, false);
                    let outer_content = if constant_at_group {
                        "0 1 0 0 k 4 4 32 32 re f /Zero gs /Child Do"
                    } else {
                        "0 1 0 0 k 4 4 32 32 re f /Child Do"
                    };
                    let outer = form(
                        doc,
                        outer_content,
                        dictionary! {
                            "XObject" => dictionary! { "Child" => child },
                            "ExtGState" => dictionary! { "Zero" => dictionary! { "ca" => 0., "AIS" => outer_ais } },
                        },
                        false,
                        true,
                    );
                    dictionary! { "XObject" => dictionary! { "Outer" => outer } }
                });
                let page = render(&doc);
                let expected = if outer_ais {
                    [0., 1., 0., 0.]
                } else {
                    [1., 0., 0., 0.]
                };
                assert_ink(
                    &page,
                    20,
                    20,
                    expected,
                    "Group ca0 không được đồng nhất shape với alpha",
                );
                assert_c1_guard(&page);
            }
        }
    }
}

#[test]
fn ordinary_form_without_group_keeps_its_children_as_knockout_siblings() {
    let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
        let plain = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "Resources" => dictionary! { "ExtGState" => dictionary! {
                    "Half" => dictionary! { "ca" => 0.5 },
                } },
            },
            b"/Half gs 0 1 0 0 k 8 8 24 24 re f 0 0 0 1 k 12 12 16 16 re f".to_vec(),
        ));
        let outer = form(
            doc,
            "0 0 1 0 k 4 4 32 32 re f /Plain Do",
            dictionary! { "XObject" => dictionary! { "Plain" => plain } },
            false,
            true,
        );
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    let page = render(&doc);
    // Form không có /Group không tạo một đối tượng ghép M+K. Con cuối K
    // khoét cả M/Y trước nó, pha nửa opacity trực tiếp với initial backdrop C.
    assert_ink(
        &page,
        20,
        20,
        [0.5, 0., 0., 0.5],
        "Form thường không phải transparency group",
    );
    assert_ink(
        &page,
        10,
        20,
        [0.5, 0.5, 0., 0.],
        "Con M riêng của Form thường",
    );
    assert_ink(
        &page,
        6,
        20,
        [0., 0., 1., 0.],
        "BBox Form không phải shape được tô",
    );
    assert_c1_guard(&page);
}

#[test]
fn graphics_state_q_q_restores_ais_before_the_next_knockout_object() {
    let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
        let outer = form(doc,
            "0 1 0 0 k 4 4 32 32 re f q /Shape gs 0 0 0 1 k 12 12 16 16 re f Q /Half gs 0 0 1 0 k 16 16 8 8 re f",
            dictionary! { "ExtGState" => dictionary! {
                "Shape" => dictionary! { "ca" => 0.5, "AIS" => true },
                "Half" => dictionary! { "ca" => 0.5 },
            } }, false, true);
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    let page = render(&doc);
    assert_ink(
        &page,
        14,
        20,
        [0., 0.5, 0., 0.5],
        "AIS=true chỉ thay nửa shape",
    );
    assert_ink(
        &page,
        20,
        20,
        [0.5, 0., 0.5, 0.],
        "Q phải khôi phục AIS=false cho nguồn Y",
    );
    assert_c1_guard(&page);
}

#[test]
fn group_entry_inherits_ais_but_resets_the_alpha_constant() {
    for child_sets_half_alpha in [false, true] {
        let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
            let content = if child_sets_half_alpha {
                "/Half gs 0 0 0 1 k 12 12 16 16 re f"
            } else {
                "0 0 0 1 k 12 12 16 16 re f"
            };
            let child = form(
                doc,
                content,
                dictionary! { "ExtGState" => dictionary! {
                    "Half" => dictionary! { "ca" => 0.5 },
                } },
                false,
                false,
            );
            let outer = form(
                doc,
                "0 1 0 0 k 4 4 32 32 re f /Shape gs /Child Do",
                dictionary! {
                    "XObject" => dictionary! { "Child" => child },
                    "ExtGState" => dictionary! { "Shape" => dictionary! { "ca" => 0.5, "AIS" => true } },
                },
                false,
                true,
            );
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        let page = render(&doc);
        // ISO 11.6.6 reset ca về1, không reset AIS. ca ngoài=.5 là shape
        // của cả group. ca trong=.5 nếu có cũng là shape do AIS kế thừa.
        let expected = if child_sets_half_alpha {
            [0., 0.75, 0., 0.25]
        } else {
            [0., 0.5, 0., 0.5]
        };
        assert_ink(
            &page,
            20,
            20,
            expected,
            "Group giữ AIS nhưng không nhân lại ca của caller",
        );
        assert_c1_guard(&page);
    }
}

#[test]
fn c1_does_not_certify_unmigrated_primitives_inside_knockout() {
    for kind in [
        "image",
        "soft-mask",
        "shading",
        "spot",
        "non-normal",
        "combined-path",
    ] {
        let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
            let mut resources = Dictionary::new();
            let content = match kind {
                "image" => {
                    let image = doc.add_object(Stream::new(
                        dictionary! {
                            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                            "BitsPerComponent" => 8, "ColorSpace" => "DeviceCMYK",
                        },
                        vec![0, 255, 0, 0],
                    ));
                    resources.set("XObject", dictionary! { "Im" => image });
                    "q 20 0 0 20 10 10 cm /Im Do Q"
                }
                "soft-mask" => {
                    let mask = form(
                        doc,
                        "0 0 0 .5 k 0 0 40 40 re f",
                        Dictionary::new(),
                        true,
                        false,
                    );
                    resources.set(
                        "ExtGState",
                        dictionary! { "A" => dictionary! {
                            "SMask" => dictionary! { "S" => "Luminosity", "G" => mask },
                        } },
                    );
                    "/A gs 0 1 0 0 k 8 8 24 24 re f"
                }
                "shading" => {
                    resources.set("Shading", dictionary! { "Sh" => dictionary! {
                        "ShadingType" => 2, "ColorSpace" => "DeviceCMYK", "Coords" => vec![0.into(), 0.into(), 40.into(), 0.into()],
                        "Function" => dictionary! { "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()],
                            "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
                            "C1" => vec![0.into(), 1.into(), 0.into(), 0.into()], "N" => 1 },
                        "Extend" => vec![true.into(), true.into()],
                    } });
                    "/Sh sh"
                }
                "spot" => {
                    resources.set("ColorSpace", dictionary! { "S" => vec![Object::Name(b"Separation".to_vec()),
                        Object::Name(b"Spot_Test".to_vec()), Object::Name(b"DeviceCMYK".to_vec()),
                        Object::Dictionary(dictionary! { "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()],
                            "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
                            "C1" => vec![0.into(), 1.into(), 0.into(), 0.into()], "N" => 1 })] });
                    "/S cs 1 scn 8 8 24 24 re f"
                }
                "non-normal" => {
                    resources.set(
                        "ExtGState",
                        dictionary! { "A" => dictionary! { "BM" => "Multiply" } },
                    );
                    "/A gs 0 1 0 0 k 8 8 24 24 re f"
                }
                _ => "0 1 0 0 k 0 0 0 1 K 4 w 8 8 24 24 re B",
            };
            let outer = form(doc, content, resources, false, true);
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        assert_c1_guard(&render(&doc));
    }
}

#[test]
fn fractional_shape_tracks_group_shape_independently_from_group_alpha() {
    for isolated in [false, true] {
        for ais in [false, true] {
            let mut page = InkBuffer::new(2, 1, InkSpace::new()).unwrap();
            page.composite(&[1., 1.], &paint([1., 0., 0., 0.], 1.))
                .unwrap();
            let mut group = page.child_transparency_group(isolated, true).unwrap();
            group
                .composite_group_region(
                    &[0.5, 0.],
                    Region::full(2, 1),
                    &paint([0., 1., 0., 0.], 1.),
                    false,
                )
                .unwrap();
            group
                .composite_group_region(
                    &[0.25, 0.],
                    Region::full(2, 1),
                    &paint([0., 0., 0., 1.], 0.5),
                    ais,
                )
                .unwrap();
            // F=union(.5,.25)=.625, GA=.5*.75+.125=.5; nếu AIS=true
            // thì f2=a2=.125, F=GA=.5625. Không dùng kết quả renderer làm oracle.
            let expected_shape = if ais { 0.5625 } else { 0.625 };
            let expected_alpha = if ais { 0.5625 } else { 0.5 };
            assert_eq!(group.group_shape_plane().unwrap(), &[expected_shape, 0.]);
            assert_eq!(group.alpha_plane(), &[expected_alpha, 0.]);
            assert!(group.has_complete_transparency_group());
            page.merge_transparency_group(&group, Region::full(2, 1), 1., false)
                .unwrap();
            assert_buffer(
                &page,
                0,
                if ais {
                    [0.4375, 0.4375, 0., 0.125]
                } else {
                    [0.5, 0.375, 0., 0.125]
                },
            );
            assert_buffer(&page, 1, [1., 0., 0., 0.]);
        }
    }
}

#[test]
fn non_knockout_child_with_shape_but_zero_alpha_erases_sibling() {
    let mut page = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
    page.composite(&[1.], &paint([1., 0., 0., 0.], 1.)).unwrap();
    let mut outer = page.child_transparency_group(false, true).unwrap();
    outer
        .composite_group_region(
            &[1.],
            Region::full(1, 1),
            &paint([0., 1., 0., 0.], 1.),
            false,
        )
        .unwrap();
    let mut inner = outer.child_transparency_group(false, false).unwrap();
    assert_buffer(&inner, 0, [1., 0., 0., 0.]);
    inner
        .composite_group_region(
            &[1.],
            Region::full(1, 1),
            &paint([0., 0., 0., 1.], 0.),
            false,
        )
        .unwrap();
    assert_eq!(inner.group_shape_plane().unwrap(), &[1.]);
    assert_eq!(inner.alpha_plane(), &[0.]);
    outer
        .merge_transparency_group(&inner, Region::full(1, 1), 1., false)
        .unwrap();
    assert_buffer(&outer, 0, [1., 0., 0., 0.]);
    assert_eq!(outer.alpha_plane(), &[0.]);
    assert_eq!(outer.group_shape_plane().unwrap(), &[1.]);
}

#[test]
fn shape_composite_and_group_merge_are_limited_to_the_requested_region() {
    let mut page = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
    page.composite(&[1.; 4], &paint([1., 0., 0., 0.], 1.))
        .unwrap();
    let mut group = page.child_transparency_group(false, true).unwrap();
    group
        .composite_group_region(
            &[1.; 4],
            Region::full(2, 2),
            &paint([0., 1., 0., 0.], 1.),
            false,
        )
        .unwrap();
    let last_pixel = Region {
        x0: 1,
        y0: 1,
        x1: u32::MAX,
        y1: u32::MAX,
    };
    group
        .composite_group_region(&[1.; 4], last_pixel, &paint([0., 0., 0., 1.], 0.5), false)
        .unwrap();
    for index in 0..3 {
        assert_buffer(&group, index, [0., 1., 0., 0.]);
    }
    assert_buffer(&group, 3, [0.5, 0., 0., 0.5]);
    page.merge_transparency_group(&group, last_pixel, 1., false)
        .unwrap();
    for index in 0..3 {
        assert_buffer(&page, index, [1., 0., 0., 0.]);
    }
    assert_buffer(&page, 3, [0.5, 0., 0., 0.5]);
}

#[test]
fn failed_group_allocation_and_drop_return_the_shared_budget() {
    let page = InkBuffer::new_with_memory_budget(2, 1, InkSpace::new(), 100).unwrap();
    let baseline = page.memory_used_bytes();
    // Non-I cần thêm 10 planes ×2px; I chỉ cần6. Sau lỗi reserve, group nhỏ
    // hợp lệ vẫn phải mở được thay vì chịu phần RAM đặt chỗ đã bị rò.
    for _ in 0..2 {
        assert!(matches!(
            page.child_transparency_group(false, true),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
        assert_eq!(page.memory_used_bytes(), baseline);
    }
    {
        let child = page.child_transparency_group(true, true).unwrap();
        assert!(child.has_complete_transparency_group());
        assert!(page.memory_used_bytes() > baseline);
    }
    assert_eq!(page.memory_used_bytes(), baseline);
}

#[test]
fn cropped_viewport_keeps_knockout_initial_backdrop_and_shape_aligned() {
    for isolated in [false, true] {
        let doc = two_objects(isolated, true, false, 0.5, false);
        let page = render_page_managed_region(
            &doc,
            1,
            72.,
            PageBox::Crop,
            RenderOptions::ink_accurate(),
            None,
            Some(RasterClip {
                x: 16,
                y: 16,
                width: 8,
                height: 8,
            }),
        )
        .unwrap();
        assert_eq!((page.buffer.width(), page.buffer.height()), (8, 8));
        for y in 0..8 {
            for x in 0..8 {
                assert_ink(
                    &page,
                    x,
                    y,
                    [0.5, 0., 0., 0.5],
                    "Viewport chỉ nằm trong vùng K nửa opacity",
                );
            }
        }
        assert_c1_guard(&page);
    }
}

#[test]
fn interpreter_c1_allocation_failure_keeps_legacy_unsupported_output_available() {
    let doc = two_objects(false, true, false, 0.5, false);
    // 40×40: trang CMYK+alpha32k và rasterizer<10k. Legacy non-I/Normal
    // group opacity1 có thể chạy ngay trên trang; C1 phải thêm64k (10planes)
    // nên budget64k chắc chắn không đủ. Đây là kiểm fallback, KHÔNG tuyên bố
    // pixel fallback đúng knockout: guard phải chặn mọi chứng nhận màu.
    let page = render_page(
        &doc,
        1,
        72.,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(64_000),
    )
    .expect("Thiếu buffer C1 không được làm đường cũ vốn đã unsupported thành lỗi cứng");
    assert_eq!((page.buffer.width(), page.buffer.height()), (40, 40));
    assert!(page.buffer.memory_used_bytes() <= page.buffer.memory_limit_bytes());
    assert_c1_guard(&page);
}

/// QUALITY (audit 2026-09-28 §KNOCK.C2): mask Alpha có trị số giải tích,
/// không qua đổi màu/luminosity và không dùng output PPE làm chuẩn.
fn constant_alpha_mask(doc: &mut Document, alpha: f32) -> Object {
    form(
        doc,
        "/MaskAlpha gs 0 0 0 1 k 0 0 40 40 re f",
        dictionary! { "ExtGState" => dictionary! {
            "MaskAlpha" => dictionary! { "ca" => alpha },
        } },
        true,
        false,
    )
}

#[test]
fn c2_path_soft_mask_changes_opacity_or_shape_without_erasing_outside_clip() {
    for isolated in [false, true] {
        for ais in [false, true] {
            for mask_alpha in [0., 0.5, 1.] {
                for stroke in [false, true] {
                    let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                        let mask = constant_alpha_mask(doc, mask_alpha);
                        let second = if stroke {
                            "0 0 0 1 K 16 w 20 12 m 20 28 l S"
                        } else {
                            "0 0 0 1 k 12 12 16 16 re f"
                        };
                        let content =
                            format!("0 1 0 0 k 4 4 32 32 re f q 8 8 16 24 re W n /A gs {second} Q");
                        let outer = form(
                            doc,
                            &content,
                            dictionary! {
                                "ExtGState" => dictionary! { "A" => dictionary! {
                                    "ca" => if stroke { 0. } else { 0.5 }, "CA" => 0.5,
                                    "AIS" => ais,
                                    "SMask" => dictionary! { "S" => "Alpha", "G" => mask },
                                } },
                            },
                            isolated,
                            true,
                        );
                        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
                    });
                    let page = render(&doc);
                    let effective_alpha = mask_alpha * 0.5;
                    assert_ink(
                        &page,
                        20,
                        20,
                        if ais {
                            [0., 1. - effective_alpha, 0., effective_alpha]
                        } else {
                            [1. - effective_alpha, 0., 0., effective_alpha]
                        },
                        "SMask và ca cùng được AIS phân loại, không gộp mask vào hình học",
                    );
                    assert_ink(
                        &page,
                        26,
                        20,
                        [0., 1., 0., 0.],
                        "Clip thật luôn giới hạn shape",
                    );
                    assert_ink(
                        &page,
                        10,
                        20,
                        [0., 1., 0., 0.],
                        "Ngoài path không bị mask xóa sibling",
                    );
                    assert_c1_guard(&page);
                }
            }
        }
    }
}

#[test]
fn c2_group_soft_mask_is_applied_once_at_the_object_boundary() {
    for isolated in [false, true] {
        for ais in [false, true] {
            for mask_alpha in [0., 0.5, 1.] {
                let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                    let mask = constant_alpha_mask(doc, mask_alpha);
                    let inner = form(
                        doc,
                        "0 0 0 1 k 12 12 16 16 re f",
                        Dictionary::new(),
                        isolated,
                        false,
                    );
                    let outer = form(
                        doc,
                        "0 1 0 0 k 4 4 32 32 re f /A gs /Inner Do",
                        dictionary! {
                            "XObject" => dictionary! { "Inner" => inner },
                            "ExtGState" => dictionary! { "A" => dictionary! {
                                "ca" => 0.5, "AIS" => ais,
                                "SMask" => dictionary! { "S" => "Alpha", "G" => mask },
                            } },
                        },
                        false,
                        true,
                    );
                    dictionary! { "XObject" => dictionary! { "Outer" => outer } }
                });
                let page = render(&doc);
                let effective_alpha = mask_alpha * 0.5;
                assert_ink(
                    &page,
                    20,
                    20,
                    if ais {
                        [0., 1. - effective_alpha, 0., effective_alpha]
                    } else {
                        [1. - effective_alpha, 0., 0., effective_alpha]
                    },
                    "Mask của group không được nhân lại trên primitive con",
                );
                assert_ink(
                    &page,
                    8,
                    20,
                    [0., 1., 0., 0.],
                    "BBox group không thay thế shape",
                );
                assert_c1_guard(&page);
            }
        }
    }
}

#[test]
fn c2_combined_fill_stroke_uses_implicit_knockout_with_distinct_alphas() {
    for operator in ["B", "B*", "b", "b*"] {
        for isolated in [false, true] {
            let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                // Sibling Y phải bị shape CẢ object B xóa trong parent K.
                let content = format!(
                    "0 0 1 0 k 4 4 32 32 re f /A gs 0 1 0 0 k 0 0 0 1 K 8 w 8 8 24 24 re {operator}"
                );
                let outer = form(
                    doc,
                    &content,
                    dictionary! { "ExtGState" => dictionary! {
                        "A" => dictionary! { "ca" => 0.5, "CA" => 0.25, "AIS" => false },
                    } },
                    isolated,
                    true,
                );
                dictionary! { "XObject" => dictionary! { "Outer" => outer } }
            });
            let page = render(&doc);
            assert_ink(&page, 20, 20, [0.5, 0.5, 0., 0.], "Vùng chỉ fill dùng ca");
            assert_ink(
                &page,
                10,
                20,
                [0.75, 0., 0., 0.25],
                "Nét CA=.25 khoét fill, không pha với fill",
            );
            assert_ink(
                &page,
                6,
                20,
                [0.75, 0., 0., 0.25],
                "Vùng chỉ stroke dùng CA",
            );
            assert_ink(
                &page,
                2,
                20,
                [1., 0., 0., 0.],
                "Ngoài shape không bị BBox xóa",
            );
            assert_c1_guard(&page);
        }
    }
}

#[test]
fn c2_combined_fill_stroke_in_non_knockout_child_does_not_double_blend_border() {
    for operator in ["B", "B*"] {
        let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
            let content = format!(
                "0 0 1 0 k 4 4 32 32 re f /A gs 0 1 0 0 k 0 0 0 1 K 8 w 8 8 24 24 re {operator}"
            );
            let inner = form(
                doc,
                &content,
                dictionary! { "ExtGState" => dictionary! {
                    "A" => dictionary! { "ca" => 0.5, "CA" => 0.25 },
                } },
                false,
                false,
            );
            let outer = form(
                doc,
                "/Inner Do",
                dictionary! { "XObject" => dictionary! { "Inner" => inner } },
                false,
                true,
            );
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        let page = render(&doc);
        // Backdrop của implicit K là Y ngay trước B, không phải C ở group ngoài.
        assert_ink(
            &page,
            10,
            20,
            [0., 0., 0.75, 0.25],
            "B trong non-K vẫn không pha stroke lên fill",
        );
        assert_ink(
            &page,
            20,
            20,
            [0., 0.5, 0.5, 0.],
            "Vùng chỉ fill pha với Y trước object",
        );
        assert_c1_guard(&page);
    }
}

#[test]
fn c2_zero_opacity_combined_stroke_preserves_shape_but_ais_zero_preserves_fill() {
    for ais in [false, true] {
        let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
            let outer = form(
                doc,
                "0 0 1 0 k 4 4 32 32 re f /A gs 0 1 0 0 k 0 0 0 1 K 8 w 8 8 24 24 re B",
                dictionary! { "ExtGState" => dictionary! {
                    "A" => dictionary! { "ca" => 0.5, "CA" => 0., "AIS" => ais },
                } },
                false,
                true,
            );
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        let page = render(&doc);
        assert_ink(
            &page,
            10,
            20,
            if ais {
                [0., 0.5, 0.5, 0.]
            } else {
                [1., 0., 0., 0.]
            },
            "CA=0 là shape0 khi AIS=true, nhưng opacity0 vẫn khoét fill khi AIS=false",
        );
        assert_c1_guard(&page);
    }
}

#[test]
fn c2_incomplete_group_replays_legacy_without_reusing_partial_c1_backdrop() {
    fn mixed_document(knockout: bool) -> Document {
        document("1 0 0 0 k 0 0 40 40 re f /Fade gs /Outer Do", |doc| {
            let image = doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                    "BitsPerComponent" => 8, "ColorSpace" => "DeviceCMYK",
                },
                vec![0, 0, 255, 0],
            ));
            let outer = form(doc,
                "/Half gs 0 1 0 0 k 4 4 32 32 re f q /Op gs 16 0 0 16 12 12 cm /Im Do Q 0 0 0 1 k 16 16 8 8 re f",
                dictionary! {
                    "XObject" => dictionary! { "Im" => image },
                    "ExtGState" => dictionary! {
                        "Half" => dictionary! { "ca" => 0.5 },
                        "Op" => dictionary! { "op" => true },
                    },
                }, false, knockout);
            dictionary! {
                "XObject" => dictionary! { "Outer" => outer },
                "ExtGState" => dictionary! { "Fade" => dictionary! { "ca" => 0.5 } },
            }
        })
    }
    let legacy = render(&mixed_document(false));
    let guarded = render(&mixed_document(true));
    // Đây là oracle replay đường cũ, KHÔNG phải chứng minh pixel đúng knockout.
    // Hạ guard là bắt buộc vì overprint chưa chuyển sang shape/opacity.
    assert_c1_guard(&guarded);
    assert!(!legacy.warnings.ink_unsound(), "{:?}", legacy.warnings);
    for channel in 0..4 {
        assert_eq!(
            guarded.buffer.plane(channel),
            legacy.buffer.plane(channel),
            "Group chưa hoàn tất phải replay từ backdrop sạch; kênh {channel}"
        );
    }
    assert_eq!(
        guarded.warnings.dropped_objects,
        legacy.warnings.dropped_objects
    );
}

#[test]
fn c2_legacy_replay_preserves_decode_warning_from_an_image_cached_in_discarded_pass() {
    let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
        let image = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "BitsPerComponent" => 8, "ColorSpace" => "DeviceCMYK",
                "SMask" => 17,
            },
            vec![0, 0, 255, 0],
        ));
        let outer = form(
            doc,
            "0 1 0 0 k 4 4 32 32 re f q /Op gs 16 0 0 16 12 12 cm /Im Do Q",
            dictionary! {
                "XObject" => dictionary! { "Im" => image },
                "ExtGState" => dictionary! { "Op" => dictionary! { "op" => true } },
            },
            false,
            true,
        );
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    let page = render(&doc);
    assert_c1_guard(&page);
    assert!(
        page.warnings
            .skipped_ops
            .iter()
            .any(|(reason, _)| reason == "SMask ảnh (không giải mã được)"),
        "Rollback warning nhưng giữ image cache không được làm mất lý do SMask hỏng: {:?}",
        page.warnings
    );
    assert_eq!(
        page.warnings
            .skipped_ops
            .iter()
            .filter(|(reason, _)| reason == "Group /K true (knockout)")
            .map(|(_, count)| *count)
            .sum::<u32>(),
        1,
        "Replay một invocation không được đếm thành hai group knockout"
    );
}

#[test]
fn c2_compound_path_allocation_failure_keeps_guarded_legacy_page_available() {
    let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
        let outer = form(
            doc,
            "0 0 1 0 k 4 4 32 32 re f /A gs 0 1 0 0 k 0 0 0 1 K 8 w 8 8 24 24 re B",
            dictionary! { "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5, "CA" => 0.25 } } },
            false,
            true,
        );
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    // Trang+raster+group ngoài vừa đủ; implicit B cần thêm một backdrop/shape.
    // Replay đường cũ có guard không cần cấp phát group B thứ hai.
    let page = render_page(
        &doc,
        1,
        72.,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(140_000),
    )
    .expect("Group B thử nghiệm hết ngân sách không được làm hỏng đường fallback có guard");
    assert!(page.buffer.memory_used_bytes() <= page.buffer.memory_limit_bytes());
    assert_c1_guard(&page);
}

#[test]
fn c2_outline_collection_is_not_duplicated_by_discarded_render_replay() {
    let doc = document("/Outer Do", |doc| {
        let ttf = include_bytes!("../../backend/app/assets/fonts/DejaVuSans.ttf").to_vec();
        let font_file = doc.add_object(Stream::new(
            dictionary! { "Length1" => ttf.len() as i64 },
            ttf,
        ));
        let descriptor = doc.add_object(dictionary! {
            "Type" => "FontDescriptor", "FontName" => "DejaVuSans", "Flags" => 32,
            "ItalicAngle" => 0, "Ascent" => 900, "Descent" => -200, "CapHeight" => 700, "StemV" => 80,
            "FontBBox" => vec![(-1021).into(), (-463).into(), 1793.into(), 1232.into()],
            "FontFile2" => font_file,
        });
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "DejaVuSans",
            "Encoding" => "WinAnsiEncoding", "FontDescriptor" => descriptor,
        });
        let outer = form(
            doc,
            "BT /F1 12 Tf 4 12 Td (AB) Tj ET",
            dictionary! { "Font" => dictionary! { "F1" => font } },
            false,
            true,
        );
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    let page = render_page(
        &doc,
        1,
        72.,
        PageBox::Crop,
        RenderOptions::collecting_text_outlines(),
    )
    .expect("Thu outline không được replay thêm glyph khi renderer bỏ buffer thử nghiệm");
    assert!(page.text_outlines.is_complete(), "{:?}", page.text_outlines);
    assert_eq!(
        page.text_outlines.glyphs.len(),
        2,
        "Hai glyph phải đúng hai outline, không nhân đôi do replay"
    );
    assert_eq!(page.text_outlines.glyphs[0].glyph_index, 0);
    assert_eq!(page.text_outlines.glyphs[1].glyph_index, 1);
    assert_eq!(page.text_outlines.blocks.len(), 1);
    assert_eq!(page.text_outlines.blocks[0].code_count, 2);
}

fn image_soft_mask(doc: &mut Document, alpha: f32) -> Object {
    Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
            "Decode" => vec![0.into(), alpha.into()],
        },
        vec![255],
    )))
}

fn black_image(doc: &mut Document, kind: &str, soft_mask: Option<Object>) -> Object {
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
        "BitsPerComponent" => 8,
    };
    let data = match kind {
        "cmyk" => {
            dict.set("ColorSpace", "DeviceCMYK");
            vec![0, 0, 0, 255]
        }
        "gray" => {
            dict.set("ColorSpace", "DeviceGray");
            vec![0]
        }
        "indexed-cmyk" => {
            dict.set(
                "ColorSpace",
                Object::Array(vec![
                    Object::Name(b"Indexed".to_vec()),
                    Object::Name(b"DeviceCMYK".to_vec()),
                    Object::Integer(0),
                    Object::String(vec![0, 0, 0, 255], lopdf::StringFormat::Literal),
                ]),
            );
            vec![0]
        }
        "stencil" => {
            dict.set("ImageMask", true);
            dict.set("BitsPerComponent", 1);
            vec![0]
        }
        _ => panic!("Loại ảnh fixture không hợp lệ"),
    };
    if let Some(mask) = soft_mask {
        dict.set("SMask", mask);
    }
    Object::Reference(doc.add_object(Stream::new(dict, data)))
}

#[test]
fn c2b_image_soft_mask_preserves_knockout_shape_even_when_opacity_is_zero() {
    for kind in ["cmyk", "gray", "indexed-cmyk"] {
        for isolated in [false, true] {
            for ais in [false, true] {
                for alpha in [0., 0.5, 1.] {
                    let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                        let mask = image_soft_mask(doc, alpha);
                        let image = black_image(doc, kind, Some(mask));
                        let outer = form(
                            doc,
                            "0 1 0 0 k 4 4 32 32 re f /A gs q 16 0 0 16 12 12 cm /Im Do Q",
                            dictionary! {
                                "XObject" => dictionary! { "Im" => image },
                                "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5, "AIS" => ais } },
                            },
                            isolated,
                            true,
                        );
                        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
                    });
                    let page = render(&doc);
                    let effective = alpha * 0.5;
                    assert_ink(
                        &page,
                        20,
                        20,
                        if ais {
                            [0., 1. - effective, 0., effective]
                        } else {
                            [1. - effective, 0., 0., effective]
                        },
                        "SMask ảnh không được biến shape thành opacity hoặc bỏ pixel alpha0",
                    );
                    assert_ink(
                        &page,
                        8,
                        20,
                        [0., 1., 0., 0.],
                        "Ngoài hình chữ nhật ảnh không khoét",
                    );
                    assert_c1_guard(&page);
                }
            }
        }
    }
}

#[test]
fn c2b_plain_image_and_stencil_use_graphics_soft_mask_including_zero_opacity() {
    for kind in ["cmyk", "gray", "indexed-cmyk", "stencil"] {
        for ais in [false, true] {
            for alpha in [0., 0.5, 1.] {
                let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                    let mask = constant_alpha_mask(doc, alpha);
                    let image = black_image(doc, kind, None);
                    let outer = form(
                        doc,
                        "0 1 0 0 k 4 4 32 32 re f /A gs 0 0 0 1 k q 16 0 0 16 12 12 cm /Im Do Q",
                        dictionary! {
                            "XObject" => dictionary! { "Im" => image },
                            "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5, "AIS" => ais,
                                "SMask" => dictionary! { "S" => "Alpha", "G" => mask } } },
                        },
                        false,
                        true,
                    );
                    dictionary! { "XObject" => dictionary! { "Outer" => outer } }
                });
                let page = render(&doc);
                let effective = alpha * 0.5;
                assert_ink(
                    &page,
                    20,
                    20,
                    if ais {
                        [0., 1. - effective, 0., effective]
                    } else {
                        [1. - effective, 0., 0., effective]
                    },
                    "Không có mask ảnh thì SMask state vẫn phân loại theo AIS",
                );
                assert_c1_guard(&page);
            }
        }
    }
}

#[test]
fn c2b_image_mask_overrides_graphics_mask_and_explicit_holes_remain_shape_zero() {
    for explicit in [false, true] {
        for ais in [false, true] {
            let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                let host_mask = constant_alpha_mask(doc, 0.);
                let image =
                    if explicit {
                        let mask = doc.add_object(Stream::new(dictionary! {
                        "Subtype" => "Image", "Width" => 2, "Height" => 1, "ImageMask" => true,
                        "BitsPerComponent" => 1,
                    }, vec![0b0100_0000]));
                        Object::Reference(doc.add_object(Stream::new(dictionary! {
                        "Type" => "XObject", "Subtype" => "Image", "Width" => 2, "Height" => 1,
                        "BitsPerComponent" => 8, "ColorSpace" => "DeviceCMYK", "Mask" => mask,
                    }, vec![0, 0, 0, 255, 0, 0, 0, 255])))
                    } else {
                        let mask = image_soft_mask(doc, 0.5);
                        black_image(doc, "cmyk", Some(mask))
                    };
                let outer = form(
                    doc,
                    "0 1 0 0 k 4 4 32 32 re f /A gs q 16 0 0 16 12 12 cm /Im Do Q",
                    dictionary! {
                        "XObject" => dictionary! { "Im" => image },
                        "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5, "AIS" => ais,
                            "SMask" => dictionary! { "S" => "Alpha", "G" => host_mask } } },
                    },
                    false,
                    true,
                );
                dictionary! { "XObject" => dictionary! { "Outer" => outer } }
            });
            let page = render(&doc);
            let effective = if explicit { 0.5 } else { 0.25 };
            assert_ink(
                &page,
                16,
                20,
                if ais {
                    [0., 1. - effective, 0., effective]
                } else {
                    [1. - effective, 0., 0., effective]
                },
                "Mask trong ảnh thắng state SMask=0, không nhân hai mask",
            );
            if explicit {
                assert_ink(
                    &page,
                    24,
                    20,
                    [0., 1., 0., 0.],
                    "Lỗ explicit Mask không có shape, AIS=false cũng không khoét sibling",
                );
            }
            assert_c1_guard(&page);
        }
    }
}

#[test]
fn c2b_image_alpha_constant_zero_is_not_an_early_return_when_ais_is_opacity() {
    for ais in [false, true] {
        let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
            let image = black_image(doc, "cmyk", None);
            let outer = form(
                doc,
                "0 1 0 0 k 4 4 32 32 re f /A gs q 16 0 0 16 12 12 cm /Im Do Q",
                dictionary! {
                    "XObject" => dictionary! { "Im" => image },
                    "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0., "AIS" => ais } },
                },
                false,
                true,
            );
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        let page = render(&doc);
        assert_ink(
            &page,
            20,
            20,
            if ais {
                [0., 1., 0., 0.]
            } else {
                [1., 0., 0., 0.]
            },
            "ca=0 chỉ xóa shape khi AIS=true",
        );
        assert_c1_guard(&page);
    }
}

#[test]
fn c2b_image_soft_mask_none_keeps_host_soft_mask_active() {
    let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
        let host_mask = constant_alpha_mask(doc, 0.5);
        let image = black_image(doc, "cmyk", Some(Object::Name(b"None".to_vec())));
        let outer = form(
            doc,
            "0 1 0 0 k 4 4 32 32 re f /A gs q 16 0 0 16 12 12 cm /Im Do Q",
            dictionary! {
                "XObject" => dictionary! { "Im" => image },
                "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5,
                    "SMask" => dictionary! { "S" => "Alpha", "G" => host_mask } } },
            },
            false,
            true,
        );
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    let page = render(&doc);
    assert_ink(
        &page,
        20,
        20,
        [0.75, 0., 0., 0.25],
        "SMask /None trong image không vô hiệu state mask",
    );
    assert_c1_guard(&page);
}

#[test]
fn c2b_minified_image_averages_shape_separately_from_soft_opacity() {
    for explicit in [false, true] {
        for transparent in [false, true] {
            for ais in [false, true] {
                let doc = document("1 0 0 0 k 0 0 40 40 re f /Outer Do", |doc| {
                    let mask = if explicit {
                        doc.add_object(Stream::new(
                            dictionary! {
                                "Subtype" => "Image", "Width" => 2, "Height" => 1,
                                "ImageMask" => true, "BitsPerComponent" => 1,
                            },
                            vec![if transparent {
                                0b1100_0000
                            } else {
                                0b0100_0000
                            }],
                        ))
                    } else {
                        doc.add_object(Stream::new(
                            dictionary! {
                                "Subtype" => "Image", "Width" => 2, "Height" => 1,
                                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                            },
                            vec![if transparent { 0 } else { 255 }, 0],
                        ))
                    };
                    let mut image_dict = dictionary! {
                        "Subtype" => "Image", "Width" => 2, "Height" => 1,
                        "ColorSpace" => "DeviceCMYK", "BitsPerComponent" => 8,
                    };
                    image_dict.set(if explicit { "Mask" } else { "SMask" }, mask);
                    let image =
                        doc.add_object(Stream::new(image_dict, vec![0, 0, 0, 255, 0, 0, 0, 255]));
                    let outer = form(
                        doc,
                        "0 1 0 0 k 4 4 32 32 re f /A gs q 1 0 0 1 20 20 cm /Im Do Q",
                        dictionary! {
                            "XObject" => dictionary! { "Im" => image },
                            "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5, "AIS" => ais } },
                        },
                        false,
                        true,
                    );
                    dictionary! { "XObject" => dictionary! { "Outer" => outer } }
                });
                let page =
                    render_page(&doc, 1, 72., PageBox::Crop, RenderOptions::viewer()).unwrap();
                let alpha = if transparent { 0. } else { 0.25 };
                let shape = if ais {
                    alpha
                } else if explicit {
                    if transparent {
                        0.
                    } else {
                        0.5
                    }
                } else {
                    1.
                };
                assert_ink(
                    &page,
                    20,
                    19,
                    [shape - alpha, 1. - shape, 0., alpha],
                    "Hai texel một pixel: trung bình shape độc lập opacity, kể cả toàn bộ alpha0",
                );
                assert_preview_certificate(&page);
            }
        }
    }
}

#[test]
fn c2b_conservative_image_compares_resultant_tac_when_mask_hole_keeps_sibling() {
    for isolated in [false, true] {
        let doc = document("/Outer Do", |doc| {
            // QUALITY (audit 2026-09-28 §KNOCK.C2b): hai texel cùng K100%,
            // nhưng explicit Mask cho texel trái là lỗ, texel phải nhìn thấy.
            let mask = doc.add_object(Stream::new(
                dictionary! {
                    "Subtype" => "Image", "Width" => 2, "Height" => 1,
                    "ImageMask" => true, "BitsPerComponent" => 1,
                },
                vec![0b1000_0000],
            ));
            let image = doc.add_object(Stream::new(
                dictionary! {
                    "Subtype" => "Image", "Width" => 2, "Height" => 1,
                    "ColorSpace" => "DeviceCMYK", "BitsPerComponent" => 8,
                    "Mask" => mask,
                },
                vec![0, 0, 0, 255, 0, 0, 0, 255],
            ));
            let outer = form(
                doc,
                "1 1 1 1 k 4 4 32 32 re f q 1 0 0 1 20 20 cm /Im Do Q",
                dictionary! { "XObject" => dictionary! { "Im" => image } },
                isolated,
                true,
            );
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        // Oracle độc lập: shape=0 giữ sibling CMYK400%; shape=1 thay bằng
        // K100%. Chọn SOURCE TAC cao sẽ chọn nhầm kết quả100% thay vì400%.
        let conservative = render(&doc);
        assert_ink(
            &conservative,
            20,
            19,
            [1., 1., 1., 1.],
            "Conservative phải so TAC sau knockout, lỗ Mask giữ sibling400%",
        );
        assert_c1_guard(&conservative);

        // Viewer vẫn lấy trung bình diện tích: nửa400% + nửa100% =250%.
        let viewer = render_page(&doc, 1, 72., PageBox::Crop, RenderOptions::viewer()).unwrap();
        assert_ink(
            &viewer,
            20,
            19,
            [0.5, 0.5, 0.5, 1.],
            "Viewer không dùng phép chọn cực đại của chế độ đo mực",
        );
    }
}

#[test]
fn c2b_conservative_graphics_soft_mask_preserves_high_ink_zero_opacity_candidate() {
    // Cả hai chiều >16px để đường legacy dựng SMask không nới mép của
    // path mảnh ở chế độ đo mực, vô tình biến pixel tâm thành mask1.
    let mask_content = "0 0 0 1 k 21 2 18 36 re f";
    // Probe bằng path (không qua bộ chọn peak riêng của image) kiểm ngay
    // pixel mask mà fixture hứa cung cấp cho cả hai chế độ AIS bên dưới.
    let probe_doc = document("/A gs 0 0 0 1 k 19 18 4 4 re f", |doc| {
        let mask = form(doc, mask_content, dictionary! {}, true, false);
        dictionary! { "ExtGState" => dictionary! { "A" => dictionary! {
            "SMask" => dictionary! { "S" => "Alpha", "G" => mask },
        } } }
    });
    let probe = render(&probe_doc);
    assert_ink(
        &probe,
        20,
        19,
        [0., 0., 0., 0.],
        "Fixture phải có mask tâm0",
    );
    assert_ink(
        &probe,
        21,
        19,
        [0., 0., 0., 1.],
        "Fixture phải có peak lân cận1",
    );
    for ais in [false, true] {
        let doc = document("1 1 1 1 k 0 0 40 40 re f /Outer Do", |doc| {
            // Tại pixel(20,19) mask=0; pixel lân cận(21,19) mask=1. Đỉnh
            // gần đó là candidate, không phải luôn thay thế opacity tâm.
            let mask = form(doc, mask_content, dictionary! {}, true, false);
            let image = black_image(doc, "cmyk", None);
            let outer = form(
                doc,
                "1 1 1 1 k 4 4 32 32 re f /A gs q 1 0 0 1 20 20 cm /Im Do Q",
                dictionary! {
                    "XObject" => dictionary! { "Im" => image },
                    "ExtGState" => dictionary! { "A" => dictionary! {
                        "AIS" => ais, "SMask" => dictionary! { "S" => "Alpha", "G" => mask },
                    } },
                },
                false,
                true,
            );
            dictionary! { "XObject" => dictionary! { "Outer" => outer } }
        });
        // AIS=false: opacity0 khoét về backdrop400%; AIS=true: shape0 giữ
        // sibling400%. Cả hai đều có TAC cao hơn candidate peak1 -> K100%.
        let conservative = render(&doc);
        assert_ink(
            &conservative,
            20,
            19,
            [1., 1., 1., 1.],
            "Không ép soft-mask peak nếu nó hạ TAC sau knockout400% thành100%",
        );
        assert_c1_guard(&conservative);
        let viewer = render_page(&doc, 1, 72., PageBox::Crop, RenderOptions::viewer()).unwrap();
        assert_ink(
            &viewer,
            20,
            19,
            [1., 1., 1., 1.],
            "Viewer đọc đúng mask tâm0, không nới theo peak lân cận",
        );
    }
}
