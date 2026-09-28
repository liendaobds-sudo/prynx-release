//! COLOR (audit 2026-09-28 §KNOCK.PREVIEW): hợp đồng preview có opt-in riêng.
//! Gọi public page renderer; opt-in chỉ được bật ở cấu hình xem, không đo/xuất mực.

use super::RenderOptions;
use crate::page::{render_page, PageBox, PageRender};
use lopdf::{dictionary, Dictionary, Document, Object, Stream};

const PAINT: &str = "0 1 0 0 k 4 4 32 32 re f";

fn document(content: &str, resources: impl FnOnce(&mut Document) -> Dictionary) -> Document {
    let mut doc = Document::with_version("1.7");
    let resources = resources(&mut doc);
    let contents = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => contents, "Resources" => resources,
        "MediaBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
    });
    doc.set_object(pages, dictionary! {
        "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1,
    });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    doc
}

fn form(doc: &mut Document, content: &str, resources: Dictionary, isolated: bool, knockout: bool) -> Object {
    Object::Reference(doc.add_object(Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Form",
        "BBox" => vec![0.into(), 0.into(), 40.into(), 40.into()], "Resources" => resources,
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK", "I" => isolated, "K" => knockout },
    }, content.as_bytes().to_vec())))
}

fn simple(content: &str) -> Document {
    document("1 0 0 0 k 0 0 40 40 re f /K Do", |doc| {
        let group = form(doc, content, dictionary! {
            "ExtGState" => dictionary! {
                "Half" => dictionary! { "ca" => 0.5, "CA" => 0.5 },
                "Zero" => dictionary! { "ca" => 0.0, "CA" => 0.0 },
            },
        }, false, true);
        dictionary! { "XObject" => dictionary! { "K" => group } }
    })
}

fn opted(mut opts: RenderOptions) -> RenderOptions {
    opts.preview_vector_knockout = true;
    opts
}

fn render(doc: &Document, opts: RenderOptions) -> PageRender {
    render_page(doc, 1, 72., PageBox::Crop, opts).expect("Fixture preview phải dựng được cùng guard trung thực")
}

fn guard_count(page: &PageRender) -> u32 {
    page.warnings.skipped_ops.iter().filter(|(reason, _)| reason == "Group /K true (knockout)")
        .map(|(_, count)| *count).sum()
}

fn assert_guard(page: &PageRender, context: &str) {
    assert!(page.warnings.unsupported_transparency && guard_count(page) > 0,
        "{context}: miền chưa chứng nhận phải giữ guard {:?}", page.warnings);
}

fn assert_certified(page: &PageRender, context: &str) {
    assert_eq!(guard_count(page), 0, "{context}: {:?}", page.warnings);
    assert!(!page.warnings.unsupported_transparency, "{context}: {:?}", page.warnings);
}

fn image(doc: &mut Document, broken_mask: bool) -> Object {
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
        "BitsPerComponent" => 8, "ColorSpace" => "DeviceCMYK",
    };
    if broken_mask { dict.set("SMask", 17); }
    Object::Reference(doc.add_object(Stream::new(dict, vec![0, 0, 255, 0])))
}

fn soft_mask(doc: &mut Document, isolated: bool, knockout: bool, luminosity: bool) -> Object {
    let group = form(doc, PAINT, dictionary! {}, isolated, knockout);
    Object::Dictionary(dictionary! {
        "S" => if luminosity { "Luminosity" } else { "Alpha" }, "G" => group,
    })
}

#[test]
fn preview_opt_in_certifies_only_normal_cmyk_vector_math() {
    let doc = simple("/Half gs 0 1 0 0 k 4 4 32 32 re f 0 0 1 0 k 12 12 16 16 re f");
    for opts in [RenderOptions::softproof(), RenderOptions::viewer()] {
        let result = render(&doc, opted(opts));
        assert_certified(&result, "Hai vector CMYK Normal trong K");
        let pixel = 20 * 40 + 20;
        assert!((result.buffer.plane(0)[pixel] - 0.5).abs() < 1e-6);
        assert_eq!(result.buffer.plane(1)[pixel], 0.);
        assert!((result.buffer.plane(2)[pixel] - 0.5).abs() < 1e-6);
    }
}

#[test]
fn only_preview_constructors_opt_in_and_ink_export_stay_guarded() {
    let doc = simple(PAINT);
    for opts in [RenderOptions::default(), RenderOptions::ink_accurate(), RenderOptions::cmyk_export(),
        RenderOptions::collecting_text_outlines()]
    {
        assert!(!opts.preview_vector_knockout, "Đo/xuất mực không nhận certificate preview");
        assert_guard(&render(&doc, opts), "Constructor chưa opt-in");
    }
    for opts in [RenderOptions::softproof(), RenderOptions::viewer()] {
        assert!(opts.preview_vector_knockout);
        assert_certified(&render(&doc, opts), "Constructor preview trong miền vector");
    }
}

#[test]
fn zero_opacity_and_manual_clip_preserve_certified_knockout_shape() {
    let result = render(&simple("4 4 32 32 re W n 0 1 0 0 k 4 4 32 32 re f /Zero gs 0 0 1 0 k 12 12 16 16 re f"),
        opted(RenderOptions::softproof()));
    assert_certified(&result, "Clip vector và opacity0 vẫn có shape");
    let pixel = 20 * 40 + 20;
    assert_eq!(result.buffer.plane(0)[pixel], 1.);
    assert_eq!(result.buffer.plane(1)[pixel], 0.);
}

#[test]
fn nested_ordinary_forms_and_non_knockout_groups_do_not_lose_the_certificate() {
    let doc = document("/K Do", |doc| {
        let leaf = form(doc, PAINT, dictionary! {}, false, false);
        let ordinary = doc.add_object(Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Leaf" => leaf } },
        }, b"/Leaf Do".to_vec()));
        let group = form(doc, "/Ordinary Do", dictionary! {
            "XObject" => dictionary! { "Ordinary" => ordinary },
        }, false, true);
        dictionary! { "XObject" => dictionary! { "K" => group } }
    });
    assert_certified(&render(&doc, opted(RenderOptions::softproof())), "Form thường và nonK lồng");
}

#[test]
fn uncertified_primitives_and_zero_alpha_rgb_keep_the_guard() {
    for kind in ["pattern", "text", "text_clip", "rgb_zero"] {
        let doc = document("/K Do", |doc| {
            let image = image(doc, false);
            let mask = soft_mask(doc, false, false, false);
            let glyph = doc.add_object(Stream::new(dictionary! {}, b"400 0 0 0 400 400 d1 0 0 400 400 re f".to_vec()));
            let font = doc.add_object(dictionary! {
                "Type" => "Font", "Subtype" => "Type3", "FontBBox" => vec![0.into(),0.into(),400.into(),400.into()],
                "FontMatrix" => vec![0.001.into(),0.into(),0.into(),0.001.into(),0.into(),0.into()],
                "CharProcs" => dictionary! { "A" => glyph },
                "Encoding" => dictionary! { "Type" => "Encoding", "Differences" => vec![65.into(),Object::Name(b"A".to_vec())] },
                "FirstChar" => 65, "LastChar" => 65, "Widths" => vec![400.into()], "Resources" => dictionary! {},
            });
            let shading = dictionary! {
                "ShadingType" => 2, "ColorSpace" => "DeviceCMYK", "Coords" => vec![0.into(),0.into(),40.into(),0.into()],
                "Function" => dictionary! { "FunctionType" => 2, "Domain" => vec![0.into(),1.into()],
                    "C0" => vec![0.into(),0.into(),0.into(),0.into()], "C1" => vec![1.into(),0.into(),0.into(),0.into()], "N" => 1 },
                "Extend" => vec![true.into(),true.into()],
            };
            let body = match kind {
                "shading" => "/Sh sh",
                "pattern" => "/Pattern cs /P scn 0 0 40 40 re f",
                "text" => "0 1 0 0 k BT /F 20 Tf 8 8 Td (A) Tj ET",
                "text_clip" => "0 1 0 0 k BT /F 20 Tf 7 Tr 8 8 Td (A) Tj ET 0 0 40 40 re f",
                _ => "/Zero gs 1 0 0 rg 4 4 32 32 re f",
            };
            let group = form(doc, body, dictionary! {
                "XObject" => dictionary! { "Im" => image }, "Font" => dictionary! { "F" => font },
                "Shading" => dictionary! { "Sh" => shading.clone() },
                "Pattern" => dictionary! { "P" => dictionary! { "PatternType" => 2, "Shading" => shading } },
                "ExtGState" => dictionary! { "Zero" => dictionary! { "ca" => 0 }, "Mask" => dictionary! { "SMask" => mask } },
            }, false, true);
            dictionary! { "XObject" => dictionary! { "K" => group } }
        });
        assert_guard(&render(&doc, opted(RenderOptions::softproof())), kind);
    }
}

#[test]
fn unknown_operations_and_malformed_do_cannot_become_false_clean() {
    for body in ["0 1 0 0 k 4 4 32 32 re f FuturePaint", "/Missing Do", "/Broken Do", "Do"] {
        let doc = document("/K Do", |doc| {
            let group = form(doc, body, dictionary! { "XObject" => dictionary! { "Broken" => 17 } }, false, true);
            dictionary! { "XObject" => dictionary! { "K" => group } }
        });
        assert_guard(&render(&doc, opted(RenderOptions::softproof())), body);
    }
}

#[test]
fn unresolved_graphics_states_cannot_become_false_clean() {
    for body in ["/Missing gs", "/Broken gs", "gs"] {
        let doc = document("/K Do", |doc| {
            let group = form(doc, &format!("{body} {PAINT}"), dictionary! {
                "ExtGState" => dictionary! { "Broken" => 17 },
            }, false, true);
            dictionary! { "XObject" => dictionary! { "K" => group } }
        });
        assert_guard(&render(&doc, opted(RenderOptions::softproof())), body);
    }
}

#[test]
fn malformed_shading_cannot_become_a_certified_subtree() {
    for body in ["/Missing sh", "/Broken sh", "/Unsupported sh", "sh"] {
        let doc = document("/K Do", |doc| {
            let group = form(doc, body, dictionary! {
                "Shading" => dictionary! {
                    "Broken" => 17,
                    "Unsupported" => dictionary! { "ShadingType" => 42, "ColorSpace" => "DeviceCMYK" },
                },
            }, false, true);
            dictionary! { "XObject" => dictionary! { "K" => group } }
        });
        assert_guard(&render(&doc, RenderOptions::softproof()), body);
    }
}

#[test]
fn discarded_stream_or_graphics_state_cannot_certify_vector_subtree() {
    let mut shallow = opted(RenderOptions::softproof());
    shallow.max_form_depth = 0;
    let result = render(&simple(PAINT), shallow);
    assert_guard(&result, "K bị bỏ vì vượt độ sâu Form");
    assert!(result.warnings.dropped_objects > 0);

    let body = format!("{} {PAINT} {}", "q ".repeat(260), "Q ".repeat(260));
    let result = render(&simple(&body), opted(RenderOptions::softproof()));
    assert_guard(&result, "K bỏ lệnh vẽ trong episode vượt q-depth");
    assert!(result.warnings.dropped_objects > 0);
}

#[test]
fn recovered_group_stream_and_failed_inline_decode_keep_the_guard() {
    let doc = document("/K Do /K Do", |doc| {
        let group = form(doc, PAINT, dictionary! {}, false, true);
        let Object::Reference(id) = group else { unreachable!() };
        // Payload cố ý không nén dù khai Flate: renderer chỉ phục hồi raw.
        doc.get_object_mut(id).unwrap().as_stream_mut().unwrap().dict.set("Filter", "FlateDecode");
        dictionary! { "XObject" => dictionary! { "K" => Object::Reference(id) } }
    });
    let result = render(&doc, opted(RenderOptions::softproof()));
    assert_guard(&result, "Form K tự phục hồi stream phải taint sau snapshot và khi replay cache");
    assert_eq!(guard_count(&result), 2);
    assert_eq!(result.warnings.dropped_objects, 2);

    let result = render(&simple(&format!("{PAINT} BI 42 /W 1 ID x EI")), opted(RenderOptions::softproof()));
    assert_guard(&result, "Ảnh nội tuyến không giải mã được không phải vector sạch");
    assert!(result.warnings.skipped_ops.iter().any(|(reason, _)| reason == "BI (ảnh nội tuyến không đọc được)"));
}

#[test]
fn unsupported_non_knockout_child_boundary_taints_outer_knockout() {
    for kind in ["isolated", "blend", "overprint"] {
        let doc = document("/K Do", |doc| {
            let mask = soft_mask(doc, false, false, false);
            let state = match kind {
                "blend" => dictionary! { "BM" => "Hue" },
                "ais" => dictionary! { "AIS" => true },
                "mask" => dictionary! { "SMask" => mask },
                "overprint" => dictionary! { "op" => true },
                _ => dictionary! {},
            };
            let child = form(doc, PAINT, dictionary! {}, kind == "isolated", false);
            let group = form(doc, "/Boundary gs /Child Do", dictionary! {
                "XObject" => dictionary! { "Child" => child }, "ExtGState" => dictionary! { "Boundary" => state },
            }, false, true);
            dictionary! { "XObject" => dictionary! { "K" => group } }
        });
        assert_guard(&render(&doc, opted(RenderOptions::softproof())), kind);
    }
}

#[test]
fn nonce_is_subtree_local_but_never_erases_prior_warnings() {
    let doc = document("/Bad Do /Good Do", |doc| {
        let bad = form(doc, "/Missing Do", dictionary! {}, false, true);
        let good = form(doc, PAINT, dictionary! {}, false, true);
        dictionary! { "XObject" => dictionary! { "Bad" => bad, "Good" => good } }
    });
    let result = render(&doc, opted(RenderOptions::softproof()));
    assert_guard(&result, "Guard trước phải còn");
    assert_eq!(guard_count(&result), 1, "K hợp lệ sau đó không thừa hưởng taint sibling");

    let doc = document("/Broken gs /K Do", |doc| {
        let group = form(doc, PAINT, dictionary! {}, false, true);
        dictionary! { "XObject" => dictionary! { "K" => group },
            "ExtGState" => dictionary! { "Broken" => dictionary! { "SMask" => 17 } } }
    });
    let result = render(&doc, opted(RenderOptions::softproof()));
    assert_eq!(guard_count(&result), 0, "Không xóa lỗi cũ cũng không gán nhầm vào K");
    assert!(result.warnings.unsupported_transparency);
    assert!(result.warnings.skipped_ops.iter().any(|(reason,_)| reason.contains("SMask")));
}

#[test]
fn replay_keeps_nested_knockout_guards_and_cached_decode_diagnostics() {
    let doc = document("/Outer Do", |doc| {
        let image = image(doc, true);
        let inner = form(doc, PAINT, dictionary! {}, false, true);
        let outer = form(doc, "/Inner Do q /Op gs 16 0 0 16 8 8 cm /Im Do Q", dictionary! {
            "XObject" => dictionary! { "Inner" => inner, "Im" => image },
            "ExtGState" => dictionary! { "Op" => dictionary! { "op" => true } },
        }, false, true);
        dictionary! { "XObject" => dictionary! { "Outer" => outer } }
    });
    for opts in [RenderOptions::default(), opted(RenderOptions::softproof())] {
        let result = render(&doc, opts);
        assert_guard(&result, "Replay mất certificate của K con đã dựng trước fallback");
        assert_eq!(guard_count(&result), 2, "Mỗi invocation chỉ một guard dù replay");
        assert!(result.warnings.skipped_ops.iter().any(|(reason,_)| reason == "SMask ảnh (không giải mã được)"));
    }
}

#[test]
fn compound_allocation_fallback_is_never_certified() {
    let doc = simple("0 0 1 0 k 4 4 32 32 re f /Half gs 0 1 0 0 k 0 0 0 1 K 8 w 8 8 24 24 re B");
    let result = render(&doc, opted(RenderOptions::softproof()).with_memory_budget_bytes(140_000));
    assert_guard(&result, "Thiếu RAM cho implicit fill+stroke group");
    assert_eq!(guard_count(&result), 1);
}

#[test]
fn root_group_allocation_fallback_is_never_certified() {
    let result = render(&simple(PAINT), opted(RenderOptions::softproof()).with_memory_budget_bytes(80_000));
    assert_guard(&result, "Thiếu RAM ngay lúc cấp buffer tracking của K");
    assert_eq!(guard_count(&result), 1);
}

#[test]
fn soft_mask_group_knockout_and_isolated_luminosity_are_fail_loud() {
    for (isolated, knockout, luminosity) in [(false,true,false), (false,true,true), (true,false,true)] {
        let doc = document("/Mask gs 0 1 0 0 k 4 4 32 32 re f", |doc| {
            let mask = soft_mask(doc, isolated, knockout, luminosity);
            dictionary! { "ExtGState" => dictionary! { "Mask" => dictionary! { "SMask" => mask } } }
        });
        let result = render(&doc, opted(RenderOptions::softproof()));
        assert!(result.warnings.unsupported_transparency,
            "SMask G I={isolated},K={knockout},Lum={luminosity} không được false-clean: {:?}", result.warnings);
        assert!(result.warnings.skipped_ops.iter().any(|(reason,_)| reason.contains("SMask /G")));
    }
}

#[test]
fn knockout_nested_inside_soft_mask_generation_is_not_certified() {
    for (subtype, colorspace) in [("Alpha", "DeviceCMYK"), ("Luminosity", "DeviceCMYK"), ("Luminosity", "Lab")] {
        let doc = document("/Mask gs 0 1 0 0 k 4 4 32 32 re f", |doc| {
            let child = form(doc, PAINT, dictionary! {}, false, true);
            // /G tự khai non-K nên chỉ guard trực tiếp /G /K sẽ bỏ sót K con.
            let group = doc.add_object(Stream::new(dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(),0.into(),40.into(),40.into()],
                "Resources" => dictionary! { "XObject" => dictionary! { "K" => child } },
                "Group" => dictionary! { "S" => "Transparency", "CS" => Object::Name(colorspace.as_bytes().to_vec()), "K" => false, "I" => false },
            }, b"/K Do".to_vec()));
            dictionary! { "ExtGState" => dictionary! { "Mask" => dictionary! {
                "SMask" => dictionary! { "S" => Object::Name(subtype.as_bytes().to_vec()), "G" => group },
            } } }
        });
        assert_guard(&render(&doc, RenderOptions::softproof()), &format!("K trong /SMask/G {subtype}/{colorspace}"));
    }
}

fn pattern_with_knockout(paint_type: i64) -> Document {
    let content = if paint_type == 1 { "/Pattern cs /P scn 0 0 40 40 re f" }
        else { "/PCS cs 0 1 0 0 /P scn 0 0 40 40 re f" };
    document(content, |doc| {
        let child = form(doc, PAINT, dictionary! {}, false, true);
        let pattern = doc.add_object(Stream::new(dictionary! {
            "Type" => "Pattern", "PatternType" => 1, "PaintType" => paint_type, "TilingType" => 1,
            "BBox" => vec![0.into(),0.into(),40.into(),40.into()], "XStep" => 40, "YStep" => 40,
            "Resources" => dictionary! { "XObject" => dictionary! { "K" => child } },
        }, b"/K Do".to_vec()));
        dictionary! {
            "Pattern" => dictionary! { "P" => pattern },
            "ColorSpace" => dictionary! { "PCS" => vec![Object::Name(b"Pattern".to_vec()), Object::Name(b"DeviceCMYK".to_vec())] },
        }
    })
}

#[test]
fn knockout_nested_inside_colored_pattern_is_not_certified() {
    assert_guard(&render(&pattern_with_knockout(1), RenderOptions::softproof()), "K trong ô tiling có màu");
}

#[test]
fn knockout_nested_inside_uncolored_pattern_is_not_certified() {
    assert_guard(&render(&pattern_with_knockout(2), RenderOptions::softproof()), "K trong ô tiling không màu");
}

fn type3_with_knockout(width_operator: &str) -> Document {
    document("0 1 0 0 k BT /F 1 Tf 0 0 Td (A) Tj ET", |doc| {
        let child = form(doc, PAINT, dictionary! {}, false, true);
        let glyph = doc.add_object(Stream::new(dictionary! {}, format!("{width_operator} /K Do").into_bytes()));
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type3", "FontBBox" => vec![0.into(),0.into(),40.into(),40.into()],
            "FontMatrix" => vec![1.into(),0.into(),0.into(),1.into(),0.into(),0.into()],
            "CharProcs" => dictionary! { "A" => glyph },
            "Encoding" => dictionary! { "Type" => "Encoding", "Differences" => vec![65.into(),Object::Name(b"A".to_vec())] },
            "FirstChar" => 65, "LastChar" => 65, "Widths" => vec![40.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "K" => child } },
        });
        dictionary! { "Font" => dictionary! { "F" => font } }
    })
}

#[test]
fn knockout_nested_inside_type3_d0_is_not_certified() {
    assert_guard(&render(&type3_with_knockout("40 0 d0"), RenderOptions::softproof()), "K trong CharProc d0");
}

#[test]
fn knockout_nested_inside_type3_d1_is_not_certified() {
    assert_guard(&render(&type3_with_knockout("40 0 0 0 40 40 d1"), RenderOptions::softproof()), "K trong CharProc d1");
}

#[test]
fn type3_context_is_restored_after_success_or_nested_allocation_error() {
    for width_operator in ["40 0 d0", "40 0 0 0 40 40 d1"] {
        for broken in [false, true] {
            let mut doc = type3_with_knockout(width_operator);
            if broken {
                for object in doc.objects.values_mut() {
                    if let Object::Stream(stream) = object {
                        if stream.dict.get(b"Subtype").ok().and_then(|v| v.as_name().ok()) == Some(b"Form") {
                            // Group isolated buộc cấp surface thật dù tracking thiếu
                            // RAM; lỗi xảy ra sau khi context CharProc đã được mở.
                            stream.dict.set("Group", dictionary! {
                                "S" => "Transparency", "CS" => "DeviceCMYK", "I" => true, "K" => true,
                            });
                        }
                    }
                }
            }
            let descriptor = crate::page::build_page_descriptor(&doc, 1).unwrap();
            let budget = if broken { 50_000 } else { 1_000_000 };
            let buffer = crate::ink::InkBuffer::new_with_memory_budget(40, 40, crate::ink::InkSpace::preview(), budget).unwrap();
            let mut renderer = super::Renderer::new(&doc, buffer, RenderOptions::softproof().with_memory_budget_bytes(budget), None, super::BlendSpace::DeviceCmyk).unwrap();
            let result = renderer.run(&doc.get_page_content(descriptor.page_id), descriptor.resources.as_ref(), crate::geom::Matrix::IDENTITY);
            if broken {
                assert!(matches!(result, Err(crate::error::PpeError::MemoryBudgetExceeded { .. })), "Fixture phải lỗi cấp phát trong glyph: {result:?}");
            } else {
                result.unwrap();
            }
            assert_eq!(renderer.type3_depth, 0, "Context Type3 không được rò khi success/error");
            assert_eq!(renderer.smask_depth, 0);
            assert_eq!(renderer.pattern_cell_depth, 0);
        }
    }
}
