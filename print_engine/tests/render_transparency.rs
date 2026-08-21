//! Test tích hợp trong suốt: blend mode, transparency group, soft mask.
//!
//! Trọng tâm vẫn là **lượng mực**, không phải "nhìn có giống Acrobat không". Ba
//! câu hỏi được chốt ở đây:
//!
//! 1. Blend mode có bị lật ngược không (Multiply hoá Screen vì quên bù không gian
//!    trừ)? Kiểm bằng bất đẳng thức, không chỉ bằng con số.
//! 2. Group alpha có bị nhân hai lần ở vùng các phần tử chồng nhau không? Đây là
//!    lỗi mà mắt khó thấy nhưng làm TAC sai hẳn.
//! 3. Soft mask luminosity ngoài `/BBox` có đúng là **đen** (không in gì) không?
//!    Nhầm chiều ở đây làm mực tràn ra cả trang.

use std::path::Path;

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, render_page_managed, PageBox, PageRender};
use print_engine::{BlendMode, PpeError};

const PAGE: i64 = 40;

/// Dựng tài liệu một trang; closure được cấp `&mut Document` để thêm form/ExtGState.
fn build_with<F>(content: &str, make_resources: F) -> Document
where
    F: FnOnce(&mut Document) -> Dictionary,
{
    let mut doc = Document::with_version("1.7");
    let resources = make_resources(&mut doc);
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let resources_id = doc.add_object(resources);
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

fn set_page_blend_space(doc: &mut Document, color_space: &str) {
    let page_id = *doc
        .get_pages()
        .values()
        .next()
        .expect("fixture phải có một trang");
    let page = doc
        .get_object_mut(page_id)
        .and_then(Object::as_dict_mut)
        .expect("page fixture phải là dictionary");
    page.set(
        "Group",
        Object::Dictionary(dictionary! {
            "S" => "Transparency", "CS" => Object::Name(color_space.as_bytes().to_vec())
        }),
    );
}

fn render_doc(doc: &Document) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

/// Thêm một Form XObject; `group` là dict `/Group` nếu form là transparency group.
fn add_form(
    doc: &mut Document,
    content: &str,
    bbox: [i64; 4],
    group: Option<Dictionary>,
) -> Object {
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => vec![bbox[0].into(), bbox[1].into(), bbox[2].into(), bbox[3].into()],
    };
    if let Some(g) = group {
        dict.set("Group", Object::Dictionary(g));
    }
    Object::Reference(doc.add_object(Stream::new(dict, content.as_bytes().to_vec())))
}

fn transparency_group(isolated: bool, knockout: bool) -> Dictionary {
    dictionary! {
        "S" => "Transparency",
        "CS" => "DeviceCMYK",
        "I" => Object::Boolean(isolated),
        "K" => Object::Boolean(knockout),
    }
}

fn px(r: &PageRender, channel: usize, x: usize, y: usize) -> u8 {
    r.buffer.plate_u8(channel)[y * r.buffer.width() as usize + x]
}

/// Toạ độ pixel giữa trang.
fn mid(r: &PageRender) -> (usize, usize) {
    (
        r.buffer.width() as usize / 2,
        r.buffer.height() as usize / 2,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Blend mode
// ─────────────────────────────────────────────────────────────────────────────

/// Nền Magenta đặc rồi vẽ đen K-only lên trên, với blend mode cho trước.
fn magenta_then_black(bm: &str) -> PageRender {
    let content = format!(
        "0 1 0 0 k 0 0 {PAGE} {PAGE} re f\n\
         /GS0 gs\n\
         0 0 0 1 k 0 0 {PAGE} {PAGE} re f"
    );
    let doc = build_with(&content, |_doc| {
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "BM" => Object::Name(bm.as_bytes().to_vec()) }
            }
        }
    });
    render_doc(&doc)
}

#[test]
fn normal_blend_still_knocks_out_the_backdrop() {
    // Đường cơ sở: không có blend, object đục phải khoét sạch Magenta nền.
    let r = magenta_then_black("Normal");
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 1, x, y), 0, "Normal phải khoét Magenta");
    assert_eq!(px(&r, 3, x, y), 255);
}

#[test]
fn multiply_blend_preserves_the_backdrop_instead_of_knocking_out() {
    // `Multiply` với nguồn "không mực" trên kênh Magenta = giữ nguyên nền. Đây là
    // hành vi thật của Acrobat và là lý do designer dùng Multiply thay overprint.
    let r = magenta_then_black("Multiply");
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 1, x, y), 255, "Multiply phải giữ Magenta nền");
    assert_eq!(px(&r, 3, x, y), 255, "K vẫn phải đặc");
    assert!((r.buffer.max_tac_percent() - 200.0).abs() < 0.5);
}

#[test]
fn multiply_and_screen_are_not_swapped_end_to_end() {
    // Test chống lỗi quên bù không gian trừ ở tầng tích hợp: nếu lật ngược,
    // Multiply sẽ cho ít mực hơn Screen.
    let m = magenta_then_black("Multiply").buffer.max_tac_percent();
    let s = magenta_then_black("Screen").buffer.max_tac_percent();
    assert!(m > s, "Multiply ({m}) phải nhiều mực hơn Screen ({s})");
}

#[test]
fn supported_blend_mode_does_not_degrade_confidence() {
    // Trước Milestone G, mọi `/BM` khác Normal đều hạ tin cậy ⇒ gần như mọi file
    // xưởng bị loại khỏi kết quả tin cậy. Mode đã dựng thì không được bật cờ nữa.
    let r = magenta_then_black("Multiply");
    assert!(
        !r.warnings.unsupported_transparency,
        "blend đã hỗ trợ không được bật cờ: {:?}",
        r.warnings.skipped_ops
    );
    assert!(!r.warnings.ink_unsound(), "{:?}", r.warnings);
}

#[test]
fn compatible_is_treated_as_normal() {
    let r = magenta_then_black("Compatible");
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 1, x, y), 0);
    assert!(!r.warnings.unsupported_transparency);
}

#[test]
fn unknown_blend_name_falls_back_to_normal_and_is_noted() {
    let r = magenta_then_black("KhongTonTai");
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 1, x, y), 0, "tên lạ phải xử như Normal");
    assert!(
        r.warnings
            .skipped_ops
            .iter()
            .any(|(op, _)| op.contains("KhongTonTai")),
        "phải để lại vết: {:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn darken_picks_the_heavier_ink_of_the_two() {
    // Nền K 40%, nguồn K 80%: Darken trong ink space = chọn bên nhiều mực hơn.
    let content = format!(
        "0 0 0 0.4 k 0 0 {PAGE} {PAGE} re f\n\
         /GS0 gs 0 0 0 0.8 k 0 0 {PAGE} {PAGE} re f"
    );
    let doc = build_with(&content, |_doc| {
        dictionary! {
            "ExtGState" => dictionary! { "GS0" => dictionary! { "BM" => "Darken" } }
        }
    });
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 3, x, y), 204, "0.8 × 255 = 204");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Transparency group
// ─────────────────────────────────────────────────────────────────────────────

fn group_doc(group: Option<Dictionary>, ca: Option<f32>, form_content: &str) -> Document {
    let mut content = String::new();
    if ca.is_some() {
        content.push_str("/GS0 gs\n");
    }
    content.push_str("/Fm0 Do");
    build_with(&content, |doc| {
        let form = add_form(doc, form_content, [0, 0, PAGE, PAGE], group);
        let mut res = dictionary! { "XObject" => dictionary! { "Fm0" => form } };
        if let Some(a) = ca {
            res.set(
                "ExtGState",
                Object::Dictionary(dictionary! {
                    "GS0" => dictionary! { "ca" => a, "CA" => a }
                }),
            );
        }
        res
    })
}

#[test]
fn opaque_normal_group_is_rendered_without_degrading_confidence() {
    let solid_k = format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = group_doc(Some(transparency_group(false, false)), None, &solid_k);
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 3, x, y), 255);
    assert!(
        !r.warnings.unsupported_transparency,
        "group đục Normal phải là đường chính xác: {:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn group_constant_alpha_scales_ink() {
    let solid_k = format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = group_doc(Some(transparency_group(false, false)), Some(0.5), &solid_k);
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 3, x, y), 128, "ca 0.5 trên K đặc");
}

#[test]
fn group_alpha_is_not_applied_twice_to_overlapping_elements() {
    // Hai hình K đặc chồng nhau trong cùng group, group alpha 0.5.
    //
    // Đúng: group được dựng đục rồi mới nhân 0.5 một lần ⇒ 50% mực.
    // Sai (áp alpha cho từng phần tử): 0.5 rồi 0.75 ⇒ 75% mực.
    //
    // Đây chính là lý do phải render group ra buffer riêng thay vì chỉ nhân alpha
    // vào từng thao tác vẽ.
    let two = format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = group_doc(Some(transparency_group(false, false)), Some(0.5), &two);
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    let v = px(&r, 3, x, y);
    assert!(
        (v as i32 - 128).abs() <= 1,
        "phải là 128 (một lần alpha), không phải 191: {v}"
    );
}

#[test]
fn non_isolated_group_with_outer_blend_keeps_backdrop_dependent_inner_blend() {
    // Nền M đặc. Bên trong group KHÔNG cách ly, K-only dùng Multiply nên phải
    // nhìn thấy nền và tạo kết quả trung gian M+K. Sau đó cả group dùng Screen:
    //
    //   Screen_ink(backdrop M, group source M+K) = M
    //
    // Alpha nội bộ 0.5 buộc đường mới phải loại backdrop bằng `ga`, không chỉ
    // đúng tình cờ khi `ga = 1`. Nếu ép group thành isolated (đường cũ), Multiply
    // bên trong chỉ thấy giấy trắng và cho K-only; Screen với nền M khi đó làm nền
    // nhạt đi — sai ngay cả khi hình vẫn còn nhìn thấy.
    let content = format!(
        "0 1 0 0 k 0 0 {PAGE} {PAGE} re f\n\
         /Outer gs /Fm0 Do"
    );
    let form_content = format!("/Inner gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let form = add_form(
            doc,
            &form_content,
            [0, 0, PAGE, PAGE],
            Some(transparency_group(false, false)),
        );
        dictionary! {
            "XObject" => dictionary! { "Fm0" => form },
            "ExtGState" => dictionary! {
                "Outer" => dictionary! { "BM" => "Screen" },
                "Inner" => dictionary! { "BM" => "Multiply", "ca" => 0.5, "CA" => 0.5 },
            },
        }
    });

    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 0, x, y), 0);
    assert_eq!(
        px(&r, 1, x, y),
        255,
        "nền M phải sống qua cả hai tầng blend"
    );
    assert_eq!(px(&r, 2, x, y), 0);
    assert_eq!(
        px(&r, 3, x, y),
        0,
        "Screen ở mức group loại K trong ví dụ này"
    );
    assert!(
        !r.warnings.unsupported_transparency,
        "tổ hợp đã dựng đúng không được hạ tin cậy: {:?}",
        r.warnings.skipped_ops
    );
    assert!(!r.warnings.ink_unsound(), "{:?}", r.warnings);
}

#[test]
fn isolated_group_still_reaches_full_ink() {
    let solid_k = format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = group_doc(Some(transparency_group(true, false)), Some(1.0), &solid_k);
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    // Đường cách ly phải chia lại alpha đúng; sai sẽ ra 0 hoặc nhạt.
    assert_eq!(px(&r, 3, x, y), 255);
}

#[test]
fn isolated_group_with_alpha_scales_ink_once() {
    let solid_k = format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = group_doc(Some(transparency_group(true, false)), Some(0.25), &solid_k);
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert!(
        (px(&r, 3, x, y) as i32 - 64).abs() <= 1,
        "{}",
        px(&r, 3, x, y)
    );
}

#[test]
fn knockout_group_is_flagged_loudly() {
    let solid_k = format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = group_doc(Some(transparency_group(false, true)), Some(0.5), &solid_k);
    let r = render_doc(&doc);
    assert!(
        r.warnings.unsupported_transparency,
        "knockout phải hạ tin cậy"
    );
    assert!(r.warnings.ink_unsound());
}

#[test]
fn spot_used_only_inside_a_group_still_gets_a_plate() {
    // Spot chỉ xuất hiện trong group: nếu không hợp colorant về buffer cha thì kẽm
    // Pantone biến mất mà báo cáo vẫn nói trang sạch.
    let form_content = format!("/CS0 cs 1 scn 0 0 {PAGE} {PAGE} re f");
    let mut doc = Document::with_version("1.7");
    let sep = Object::Array(vec![
        Object::Name(b"Separation".to_vec()),
        Object::Name(b"PANTONE 485 C".to_vec()),
        Object::Name(b"DeviceCMYK".to_vec()),
        Object::Dictionary(dictionary! {
            "FunctionType" => 2,
            "Domain" => vec![0.into(), 1.into()],
            "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
            "C1" => vec![0.into(), 1.into(), 1.into(), 0.into()],
            "N" => 1,
            "Range" => vec![
                0.into(), 1.into(), 0.into(), 1.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
            ],
        }),
    ]);
    let form_res = doc.add_object(dictionary! { "ColorSpace" => dictionary! { "CS0" => sep } });
    let form = Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "Group" => Object::Dictionary(transparency_group(true, false)),
            "Resources" => Object::Reference(form_res),
        },
        form_content.as_bytes().to_vec(),
    )));
    let resources = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Fm0" => form },
        "ExtGState" => dictionary! { "GS0" => dictionary! { "ca" => 1.0 } },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"/GS0 gs /Fm0 Do".to_vec()));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_doc(&doc);
    let names: Vec<&str> = r
        .buffer
        .space()
        .colorants()
        .iter()
        .map(|c| c.name())
        .collect();
    assert!(
        names.contains(&"PANTONE 485 C"),
        "spot trong group phải có kẽm: {names:?}"
    );
    let idx = r
        .buffer
        .space()
        .colorants()
        .iter()
        .position(|c| c.name() == "PANTONE 485 C")
        .unwrap();
    let (x, y) = mid(&r);
    assert_eq!(px(&r, idx, x, y), 255, "spot phải đặc");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Soft mask
// ─────────────────────────────────────────────────────────────────────────────

/// Trang: đặt soft mask từ một form rồi tô K đặc toàn trang.
fn soft_mask_doc(
    subtype: &str,
    mask_content: &str,
    mask_bbox: [i64; 4],
    tr: Option<Object>,
) -> Document {
    let content = format!("/GS0 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(doc, mask_content, mask_bbox, Some(group));
        let mut smask =
            dictionary! { "S" => Object::Name(subtype.as_bytes().to_vec()), "G" => form };
        if let Some(f) = tr {
            smask.set("TR", f);
        }
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "SMask" => Object::Dictionary(smask) }
            }
        }
    })
}

#[test]
fn nonseparable_blend_modes_on_cmyk_page_require_compatibility_lane() {
    // CORRECTNESS (audit 2026-08-10 §L6.5): bốn mode không tách kênh không có
    // surface RGB exact trên trang CMYK. Pixel xấp xỉ vẫn hữu ích cho đường đo,
    // nhưng Viewer hybrid phải nhận `ink_unsound` để lùi compatibility lane.
    for name in ["Hue", "Saturation", "Color", "Luminosity"] {
        let rendered = magenta_then_black(name);
        assert!(
            rendered.warnings.ink_unsound(),
            "/{name} trên DeviceCMYK phải hạ soundness: {:?}",
            rendered.warnings
        );
    }
}

/// Soft mask có BBox sentinel rất lớn nhưng clip hiện hành chỉ là ô 4×4.
fn sentinel_soft_mask_doc() -> Document {
    let content = format!("q 17 17 4 4 re W n /GS0 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f Q");
    build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(
            doc,
            "1 g -32768 -32768 65536 65536 re f",
            [-32768, -32768, 32768, 32768],
            Some(group),
        );
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Luminosity",
                        "G" => form,
                    })
                }
            }
        }
    })
}

/// Hai tầng soft-mask ảnh: đỉnh inner ở x=27 lan tới outer x=24, rồi outer lan
/// tiếp tới pixel trang x=21. `mask_before_clip=true` dựng oracle full-frame.
fn nested_image_soft_mask_doc(mask_before_clip: bool) -> Document {
    let content = if mask_before_clip {
        format!(
            "q /GSOuter gs 20 0 2 {PAGE} re W n \
             {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q"
        )
    } else {
        format!(
            "q 20 0 2 {PAGE} re W n /GSOuter gs \
             {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q"
        )
    };
    build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let inner_mask = add_form(
            doc,
            &format!("0 g 27 0 1 {PAGE} re f"),
            [0, 0, PAGE, PAGE],
            Some(group.clone()),
        );
        let image = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceCMYK",
                "BitsPerComponent" => 8,
            },
            vec![0, 0, 0, 255],
        )));
        let outer_resources = Object::Reference(doc.add_object(dictionary! {
            "ExtGState" => dictionary! {
                "GSInner" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => inner_mask,
                    })
                }
            },
            "XObject" => dictionary! { "Im0" => image.clone() },
        }));
        let outer_mask = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "Group" => Object::Dictionary(group),
                "Resources" => outer_resources,
            },
            format!("/GSInner gs {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do").into_bytes(),
        )));
        dictionary! {
            "ExtGState" => dictionary! {
                "GSOuter" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => outer_mask,
                    })
                }
            },
            "XObject" => dictionary! { "Im0" => image },
        }
    })
}

#[test]
fn luminosity_soft_mask_scales_ink_by_lightness() {
    // Form tô xám 50% trên toàn BBox ⇒ độ sáng 0.5 ⇒ mực còn một nửa.
    let mask = format!("0.5 g 0 0 {PAGE} {PAGE} re f");
    let doc = soft_mask_doc("Luminosity", &mask, [0, 0, PAGE, PAGE], None);
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    let v = px(&r, 3, x, y);
    assert!((v as i32 - 128).abs() <= 2, "mực phải còn ~50%: {v}");
    assert!(
        !r.warnings.unsupported_transparency,
        "soft mask đã dựng: {:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn managed_rgb_luminosity_soft_mask_uses_rgb_lightness_before_icc() {
    let content = format!("/GS0 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceRGB" };
        let form = add_form(
            doc,
            &format!("1 0 0 rg 0 0 {PAGE} {PAGE} re f"),
            [0, 0, PAGE, PAGE],
            Some(group),
        );
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Luminosity",
                        "G" => form,
                    })
                }
            }
        }
    });
    let Some(rendered) = managed_render(&doc) else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };
    let (x, y) = mid(&rendered);
    let actual = px(&rendered, 3, x, y) as i16;
    let expected = (0.3 * 255.0_f32).round() as i16;
    assert!(
        (actual - expected).abs() <= 1,
        "mặt nạ đỏ RGB phải có luminosity 0,30: actual={actual}, expected={expected}"
    );
    assert!(!rendered.warnings.ink_unsound(), "{:?}", rendered.warnings);
}

#[test]
fn unmanaged_rgb_luminosity_mask_does_not_require_rgb_sidecar_budget() {
    // MEMORY (audit 2026-08-09 §PRE.0B): không có ColorManager thì các paint
    // không duy trì được RGB sidecar hoàn chỉnh. Cấp sidecar ở đây chỉ tốn
    // 13 byte/pixel rồi vẫn rơi về luminosity CMYK xấp xỉ.
    let content = format!("/GS0 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceRGB" };
        let form = add_form(
            doc,
            &format!("1 0 0 rg 0 0 {PAGE} {PAGE} re f"),
            [0, 0, PAGE, PAGE],
            Some(group),
        );
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Luminosity",
                        "G" => form,
                    })
                }
            }
        }
    });
    let reference = render_doc(&doc);
    let bounded = render_page(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(82_000),
    )
    .expect("đường unmanaged không được xin RGB sidecar vô dụng");
    for channel in 0..4 {
        assert_eq!(
            bounded.buffer.plate_u8(channel),
            reference.buffer.plate_u8(channel),
            "bỏ sidecar không được đổi kênh {channel}"
        );
    }
}

#[test]
fn white_luminosity_mask_lets_all_ink_through() {
    let mask = format!("1 g 0 0 {PAGE} {PAGE} re f");
    let doc = soft_mask_doc("Luminosity", &mask, [0, 0, PAGE, PAGE], None);
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 3, x, y), 255);
}

#[test]
fn black_luminosity_mask_blocks_all_ink() {
    let mask = format!("0 g 0 0 {PAGE} {PAGE} re f");
    let doc = soft_mask_doc("Luminosity", &mask, [0, 0, PAGE, PAGE], None);
    let r = render_doc(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 0.0, "mặt nạ đen phải chặn hết");
}

#[test]
fn luminosity_backdrop_outside_bbox_is_black() {
    // BBox chỉ nửa trái, tô trắng. Ngoài BBox nền mặc định là ĐEN ⇒ không in.
    // Nếu cài sai (nền trắng), mực sẽ tràn ra cả nửa phải.
    let half = PAGE / 2;
    let mask = format!("1 g 0 0 {half} {PAGE} re f");
    let doc = soft_mask_doc("Luminosity", &mask, [0, 0, half, PAGE], None);
    let r = render_doc(&doc);
    let h = r.buffer.height() as usize / 2;
    let w = r.buffer.width() as usize;
    assert_eq!(px(&r, 3, 2, h), 255, "trong BBox phải in");
    assert_eq!(px(&r, 3, w - 3, h), 0, "ngoài BBox phải bị chặn");
}

#[test]
fn alpha_soft_mask_uses_group_coverage() {
    // Kiểu Alpha: chỉ vùng group thực sự vẽ mới cho mực qua; màu không quan trọng.
    let half = PAGE / 2;
    let mask = format!("0 g 0 0 {half} {PAGE} re f");
    let doc = soft_mask_doc("Alpha", &mask, [0, 0, PAGE, PAGE], None);
    let r = render_doc(&doc);
    let h = r.buffer.height() as usize / 2;
    let w = r.buffer.width() as usize;
    assert_eq!(px(&r, 3, 2, h), 255, "vùng group đã vẽ ⇒ alpha 1");
    assert_eq!(px(&r, 3, w - 3, h), 0, "vùng group chưa vẽ ⇒ alpha 0");
}

#[test]
fn alpha_soft_mask_outside_bbox_uses_transfer_of_zero() {
    // ISO 32000-1 §7.5.4: ngoài BBox của subtype Alpha, giá trị mask là
    // kết quả áp `/TR` lên đầu vào 0. Hàm này cố ý ánh xạ 0 → 0,25.
    let half = PAGE / 2;
    let content = format!("/GS0 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(
            doc,
            &format!("0 g 0 0 {PAGE} {PAGE} re f"),
            [0, 0, half, PAGE],
            Some(group),
        );
        let tr = dictionary! {
            "FunctionType" => 2,
            "Domain" => vec![0.into(), 1.into()],
            "C0" => vec![0.25.into()],
            "C1" => vec![1.into()],
            "N" => 1,
            "Range" => vec![0.into(), 1.into()],
        };
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => form,
                        "TR" => Object::Dictionary(tr),
                    })
                }
            }
        }
    });
    let rendered = render_doc(&doc);
    let y = rendered.buffer.height() as usize / 2;
    let width = rendered.buffer.width() as usize;
    assert_eq!(px(&rendered, 3, 2, y), 255, "mẫu alpha 1 phải cho qua");
    let outside = px(&rendered, 3, width - 3, y) as i16;
    assert!(
        (outside - 64).abs() <= 2,
        "ngoài BBox của Alpha phải dùng TR(0)=0,25: {outside}"
    );
}

#[test]
fn alpha_soft_mask_guard_pixels_outside_every_bbox_edge_use_transfer_of_zero() {
    // CORRECTNESS (audit 2026-08-09 §PRE.0A): `Region::from_bounds` giữ một
    // pixel khử răng cưa ngoài BBox. Bốn pixel đó vẫn là "ngoài BBox" theo PDF
    // và phải nhận TR(0), không được ghi cứng 0 rồi tạo viền tối quanh mặt nạ.
    let content = format!("/GS0 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(
            doc,
            &format!("0 g 0 0 {PAGE} {PAGE} re f"),
            [10, 10, 30, 30],
            Some(group),
        );
        let tr = dictionary! {
            "FunctionType" => 2,
            "Domain" => vec![0.into(), 1.into()],
            "C0" => vec![0.25.into()],
            "C1" => vec![1.into()],
            "N" => 1,
            "Range" => vec![0.into(), 1.into()],
        };
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => form,
                        "TR" => Object::Dictionary(tr),
                    })
                }
            }
        }
    });
    let rendered = render_doc(&doc);
    let expected = 64_i16;
    for (edge, x, y) in [
        ("trái", 9, 20),
        ("phải", 30, 20),
        ("trên", 20, 9),
        ("dưới", 20, 30),
    ] {
        let actual = px(&rendered, 3, x, y) as i16;
        assert!(
            (actual - expected).abs() <= 2,
            "pixel sát cạnh {edge} phải dùng TR(0)=0,25: {actual}"
        );
    }
}

#[test]
fn luminosity_bc_and_samples_both_pass_through_transfer() {
    // Trong BBox: xám 0,8 → `/TR` nghịch đảo còn 0,2. Ngoài BBox: `/BC` 0,2
    // cũng phải qua `/TR` thành 0,8.
    let half = PAGE / 2;
    let content = format!("/GS0 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(
            doc,
            &format!("0.8 g 0 0 {half} {PAGE} re f"),
            [0, 0, half, PAGE],
            Some(group),
        );
        let tr = dictionary! {
            "FunctionType" => 2,
            "Domain" => vec![0.into(), 1.into()],
            "C0" => vec![1.into()],
            "C1" => vec![0.into()],
            "N" => 1,
            "Range" => vec![0.into(), 1.into()],
        };
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Luminosity",
                        "G" => form,
                        "BC" => vec![0.2.into()],
                        "TR" => Object::Dictionary(tr),
                    })
                }
            }
        }
    });
    let rendered = render_doc(&doc);
    let y = rendered.buffer.height() as usize / 2;
    let width = rendered.buffer.width() as usize;
    let inside = px(&rendered, 3, 2, y) as i16;
    let outside = px(&rendered, 3, width - 3, y) as i16;
    assert!((inside - 51).abs() <= 2, "mẫu sau TR phải ~20%: {inside}");
    assert!(
        (outside - 204).abs() <= 2,
        "nền /BC sau TR phải ~80%: {outside}"
    );
}

#[test]
fn sentinel_bbox_is_bounded_by_clip_and_matches_direct_render() {
    let masked = sentinel_soft_mask_doc();
    // 40×40 CMYK+alpha = 32.000 byte. Ngân sách này đủ cho cửa sổ clip nhỏ
    // cùng guard-band lồng tối đa 12 px, nhưng không đủ cho child full-frame.
    let options = RenderOptions::ink_accurate().with_memory_budget_bytes(70_000);
    let rendered = render_page(&masked, 1, 72.0, PageBox::Crop, options)
        .expect("soft mask phải chỉ cấp phát theo clip nhỏ");

    let reference = build_with(
        &format!("q 17 17 4 4 re W n 0 0 0 1 k 0 0 {PAGE} {PAGE} re f Q"),
        |_doc| Dictionary::new(),
    );
    let reference = render_doc(&reference);
    for channel in 0..4 {
        assert_eq!(
            rendered.buffer.plate_u8(channel),
            reference.buffer.plate_u8(channel),
            "kênh {channel} phải parity với clip trực tiếp"
        );
    }
}

#[test]
fn bounded_soft_mask_still_fails_loudly_when_budget_is_too_small() {
    let document = sentinel_soft_mask_doc();
    let result = render_page(
        &document,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(32_100),
    );
    assert!(matches!(result, Err(PpeError::MemoryBudgetExceeded { .. })));
}

#[test]
fn root_rasterizer_storage_is_part_of_the_render_budget() {
    // MEMORY (audit 2026-08-09 §PRE.0B): buffer mực 40×40 cần đúng 32.000
    // byte; scratch mask + coverage f32 của Rasterizer cũng phải được tính.
    let document = build_with("", |_doc| Dictionary::new());
    let too_small = render_page(
        &document,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(32_000),
    );
    assert!(matches!(
        too_small,
        Err(PpeError::MemoryBudgetExceeded { .. })
    ));
    render_page(
        &document,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(42_000),
    )
    .expect("ngân sách đủ buffer và rasterizer phải render được");
}

#[test]
fn local_soft_mask_rasterizer_uses_the_shared_budget() {
    // Cửa sổ sentinel bounded cần ít hơn full-frame, nhưng vẫn phải tính
    // Rasterizer cục bộ đang sống đồng thời với rasterizer trang.
    let result = render_page(
        &sentinel_soft_mask_doc(),
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(62_000),
    );
    assert!(matches!(result, Err(PpeError::MemoryBudgetExceeded { .. })));
}

#[test]
fn bounded_soft_mask_keeps_image_peak_just_outside_clip_window() {
    // CORRECTNESS (audit 2026-08-09 §PRE.0A): đường ảnh lấy cực đại soft-mask
    // trong bán kính 3 px để tránh báo thiếu mực. Clip hình học chỉ nới 1 px;
    // đỉnh ở x=24 vì thế nằm ngoài cửa sổ cũ [19,23), nhưng vẫn phải ảnh hưởng
    // pixel x=21 đang nằm trong clip và cách đỉnh đúng 3 px.
    let content = format!("q 20 0 2 {PAGE} re W n /GS0 gs {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(
            doc,
            &format!("0 g 24 0 1 {PAGE} re f"),
            [0, 0, PAGE, PAGE],
            Some(group),
        );
        let image = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceCMYK",
                "BitsPerComponent" => 8,
            },
            vec![0, 0, 0, 255],
        )));
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => form,
                    })
                }
            },
            "XObject" => dictionary! { "Im0" => image },
        }
    });
    let rendered = render_doc(&doc);
    let y = rendered.buffer.height() as usize / 2;
    assert!(
        px(&rendered, 3, 21, y) >= 250,
        "đỉnh soft-mask cách 3 px phải được giữ cho đường ảnh"
    );
}

#[test]
fn bounded_nested_image_soft_masks_match_full_frame_with_nonzero_origin() {
    // CORRECTNESS (audit 2026-08-09 §PRE.0A): mỗi tầng ảnh có thể lan đỉnh
    // soft-mask thêm 3 px. Hai tầng cần giữ chuỗi x=27 → 24 → 21 ngay cả khi
    // cửa sổ bounded bắt đầu ở một origin khác 0.
    let bounded = render_doc(&nested_image_soft_mask_doc(false));
    let full_frame = render_doc(&nested_image_soft_mask_doc(true));
    let y = bounded.buffer.height() as usize / 2;
    assert!(
        px(&full_frame, 3, 21, y) >= 250,
        "oracle full-frame phải giữ được chuỗi đỉnh hai tầng"
    );
    for channel in 0..4 {
        assert_eq!(
            bounded.buffer.plate_u8(channel),
            full_frame.buffer.plate_u8(channel),
            "kênh {channel} của bounded phải parity với full-frame"
        );
    }
}

#[test]
fn transfer_function_inverts_the_mask() {
    // Mặt nạ đen (chặn hết) + `/TR` nghịch đảo ⇒ cho qua hết. Nếu `/TR` bị bỏ qua,
    // test này ra 0 mực.
    let tr = Object::Dictionary(dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![1.into()],
        "C1" => vec![0.into()],
        "N" => 1,
        "Range" => vec![0.into(), 1.into()],
    });
    let mask = format!("0 g 0 0 {PAGE} {PAGE} re f");
    let doc = soft_mask_doc("Luminosity", &mask, [0, 0, PAGE, PAGE], Some(tr));
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 3, x, y), 255, "/TR phải được áp");
}

#[test]
fn smask_none_clears_a_previous_mask() {
    // `/SMask /None` phải **xoá** mặt nạ. Coi `/None` như "có mặt nạ" sẽ giữ mặt nạ
    // cũ và che mất nội dung lẽ ra phải in.
    let content = format!("/GS0 gs /GS1 gs 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(doc, "0 g 0 0 40 40 re f", [0, 0, PAGE, PAGE], Some(group));
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! { "S" => "Luminosity", "G" => form })
                },
                "GS1" => dictionary! { "SMask" => "None" },
            }
        }
    });
    let r = render_doc(&doc);
    let (x, y) = mid(&r);
    assert_eq!(px(&r, 3, x, y), 255, "mặt nạ phải đã bị xoá");
}

#[test]
fn soft_mask_survives_q_restore() {
    // Soft mask nằm trong graphics state ⇒ `Q` phải phục hồi trạng thái không mặt
    // nạ. Lưu ngoài graphics state sẽ làm mặt nạ rò ra sau `Q`.
    let content = format!(
        "q /GS0 gs 0 0 0 1 k 0 0 {PAGE} {half} re f Q\n\
         0 0 0 1 k 0 {half} {PAGE} {half} re f",
        half = PAGE / 2
    );
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(doc, "0 g 0 0 40 40 re f", [0, 0, PAGE, PAGE], Some(group));
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! { "S" => "Luminosity", "G" => form })
                }
            }
        }
    });
    let r = render_doc(&doc);
    let w = r.buffer.width() as usize;
    // Trong PDF gốc y tăng lên; raster y tăng xuống ⇒ nửa dưới của content là nửa
    // trên của ảnh.
    assert_eq!(px(&r, 3, w / 2, 2), 255, "sau Q phải in bình thường");
    assert_eq!(
        px(&r, 3, w / 2, r.buffer.height() as usize - 3),
        0,
        "trong q/Q mặt nạ đen phải chặn"
    );
}

#[test]
fn soft_mask_stays_anchored_to_ctm_at_gs() {
    // Sau `gs`, CTM dịch 10 pt chỉ được dịch đối tượng tô; mặt nạ đã dựng phải
    // đứng yên ở nửa trái. Giao hai vùng vì thế chỉ còn dải x=10..20.
    let half = PAGE / 2;
    let content = format!("/GS0 gs 1 0 0 1 10 0 cm 0 0 0 1 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |doc| {
        let group = dictionary! { "S" => "Transparency", "CS" => "DeviceGray" };
        let form = add_form(
            doc,
            &format!("1 g 0 0 {half} {PAGE} re f"),
            [0, 0, PAGE, PAGE],
            Some(group),
        );
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Luminosity",
                        "G" => form,
                    })
                }
            }
        }
    });
    let rendered = render_doc(&doc);
    let y = rendered.buffer.height() as usize / 2;
    assert_eq!(px(&rendered, 3, 5, y), 0, "đối tượng đã dịch khỏi x=5");
    assert_eq!(
        px(&rendered, 3, 15, y),
        255,
        "giao mask và đối tượng phải in"
    );
    assert_eq!(
        px(&rendered, 3, 25, y),
        0,
        "mask không được chạy theo CTM sau gs"
    );
}

#[test]
fn unsupported_soft_mask_subtype_is_flagged() {
    let mask = format!("1 g 0 0 {PAGE} {PAGE} re f");
    let doc = soft_mask_doc("KhongBiet", &mask, [0, 0, PAGE, PAGE], None);
    let r = render_doc(&doc);
    assert!(
        r.warnings.unsupported_transparency,
        "kiểu mặt nạ lạ phải hạ tin cậy"
    );
}

fn managed_render(doc: &Document) -> Option<PageRender> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let cmyk = root.join("backend/app/assets/icc/FOGRA39.icc");
    let rgb = root.join("backend/app/assets/icc/sRGB.icc");
    if !cmyk.is_file() || !rgb.is_file() {
        return None;
    }
    let cm =
        ColorManager::from_profiles(&cmyk, Some(&rgb), RenderIntent::RelativeColorimetric).ok()?;
    render_page_managed(
        doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
        Some(&cm),
    )
    .ok()
}

#[test]
fn opaque_managed_rgb_does_not_trigger_blending_space_guard() {
    let content = format!("0.1 0.2 0.3 rg 0 0 {PAGE} {PAGE} re f");
    let doc = build_with(&content, |_doc| Dictionary::new());
    let Some(r) = managed_render(&doc) else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };
    assert!(!r.warnings.unsupported_transparency, "{:?}", r.warnings);
    assert!(!r.warnings.ink_unsound(), "{:?}", r.warnings);
}

#[test]
fn nonseparable_blend_modes_are_exact_on_managed_rgb_surface() {
    // CORRECTNESS (audit 2026-08-10 §L6.5): oracle phẳng dùng chính công thức
    // ISO của `BlendMode`; cả hai tài liệu đi chung ICC nên parity khóa luôn việc
    // blend phải xảy ra trên RGB trước khi quy sang CMYK.
    let backdrop = [0.15_f32, 0.65, 0.35];
    let source = [0.80_f32, 0.25, 0.55];
    for name in ["Hue", "Saturation", "Color", "Luminosity"] {
        let mode = BlendMode::from_name(name).expect("tên blend fixture phải hợp lệ");
        let expected = mode.blend_rgb(backdrop, source);
        let layered_content = format!(
            "{} {} {} rg 0 0 {PAGE} {PAGE} re f\n\
             /GS0 gs {} {} {} rg 0 0 {PAGE} {PAGE} re f",
            backdrop[0], backdrop[1], backdrop[2], source[0], source[1], source[2]
        );
        let mut layered_doc = build_with(&layered_content, |_doc| {
            dictionary! {
                "ExtGState" => dictionary! {
                    "GS0" => dictionary! { "BM" => Object::Name(name.as_bytes().to_vec()) }
                }
            }
        });
        set_page_blend_space(&mut layered_doc, "DeviceRGB");

        let flat_content = format!(
            "{} {} {} rg 0 0 {PAGE} {PAGE} re f",
            expected[0], expected[1], expected[2]
        );
        let mut flat_doc = build_with(&flat_content, |_doc| Dictionary::new());
        set_page_blend_space(&mut flat_doc, "DeviceRGB");

        let (Some(layered), Some(flat)) = (managed_render(&layered_doc), managed_render(&flat_doc))
        else {
            eprintln!("bỏ qua: không có profile ICC kiểm thử");
            return;
        };
        let (x, y) = mid(&layered);
        for channel in 0..4 {
            let actual = px(&layered, channel, x, y);
            let expected = px(&flat, channel, x, y);
            assert!(
                (actual as i16 - expected as i16).abs() <= 1,
                "/{name} channel {channel}: layered={actual}, flat={expected}"
            );
        }
        assert!(
            !layered.warnings.ink_unsound(),
            "/{name} trên DeviceRGB managed không được hạ soundness: {:?}",
            layered.warnings
        );
    }
}

#[test]
fn managed_rgb_alpha_blends_before_icc() {
    let layered_content = format!(
        "0.01 0 0 rg 0 0 {PAGE} {PAGE} re f\n\
         /GS0 gs 0.0667 0.325 0.216 rg 0 0 {PAGE} {PAGE} re f"
    );
    let mut layered_doc = build_with(&layered_content, |_doc| {
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "BM" => "Normal", "ca" => 0.4 }
            }
        }
    });
    set_page_blend_space(&mut layered_doc, "DeviceRGB");
    // RGB đúng trước ICC: 0.6 × backdrop + 0.4 × source.
    let flat_content = format!("0.03268 0.13 0.0864 rg 0 0 {PAGE} {PAGE} re f");
    let mut flat_doc = build_with(&flat_content, |_doc| Dictionary::new());
    set_page_blend_space(&mut flat_doc, "DeviceRGB");
    let (Some(layered), Some(flat)) = (managed_render(&layered_doc), managed_render(&flat_doc))
    else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };

    let (x, y) = mid(&layered);
    for ch in 0..4 {
        let actual = px(&layered, ch, x, y);
        let expected = px(&flat, ch, x, y);
        assert!(
            (actual as i16 - expected as i16).abs() <= 1,
            "channel {ch}: layered={actual}, flat={expected}"
        );
    }
    assert!(
        !layered.warnings.unsupported_transparency,
        "{:?}",
        layered.warnings
    );
    assert!(!layered.warnings.ink_unsound(), "{:?}", layered.warnings);
}

#[test]
fn managed_rgb_image_alpha_blends_before_icc() {
    let background = [0.01f32, 0.0, 0.0];
    let source = [17.0f32 / 255.0, 83.0 / 255.0, 55.0 / 255.0];
    let mixed = [
        background[0] * 0.6 + source[0] * 0.4,
        background[1] * 0.6 + source[1] * 0.4,
        background[2] * 0.6 + source[2] * 0.4,
    ];
    let layered_content = format!(
        "0.01 0 0 rg 0 0 {PAGE} {PAGE} re f\n\
         /GS0 gs q {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q"
    );
    let mut layered_doc = build_with(&layered_content, |doc| {
        let image = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
            },
            vec![17, 83, 55],
        )));
        dictionary! {
            "XObject" => dictionary! { "Im0" => image },
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "BM" => "Normal", "ca" => 0.4 }
            },
        }
    });
    set_page_blend_space(&mut layered_doc, "DeviceRGB");
    let flat_content = format!(
        "{} {} {} rg 0 0 {PAGE} {PAGE} re f",
        mixed[0], mixed[1], mixed[2]
    );
    let mut flat_doc = build_with(&flat_content, |_doc| Dictionary::new());
    set_page_blend_space(&mut flat_doc, "DeviceRGB");
    let (Some(layered), Some(flat)) = (managed_render(&layered_doc), managed_render(&flat_doc))
    else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };
    let (x, y) = mid(&layered);
    for ch in 0..4 {
        let actual = px(&layered, ch, x, y);
        let expected = px(&flat, ch, x, y);
        assert!(
            (actual as i16 - expected as i16).abs() <= 1,
            "channel {ch}: layered={actual}, flat={expected}"
        );
    }
    assert!(!layered.warnings.ink_unsound(), "{:?}", layered.warnings);
}

#[test]
fn managed_indexed_rgb_image_smask_blends_before_icc() {
    let background = [0.01f32, 0.0, 0.0];
    let source = [17.0f32 / 255.0, 83.0 / 255.0, 55.0 / 255.0];
    let alpha = 128.0f32 / 255.0;
    let mixed = [
        background[0] * (1.0 - alpha) + source[0] * alpha,
        background[1] * (1.0 - alpha) + source[1] * alpha,
        background[2] * (1.0 - alpha) + source[2] * alpha,
    ];
    let layered_content = format!(
        "0.01 0 0 rg 0 0 {PAGE} {PAGE} re f\n\
         q {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q"
    );
    let mut layered_doc = build_with(&layered_content, |doc| {
        let smask = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            vec![128],
        )));
        let palette = Object::String(vec![0, 0, 0, 17, 83, 55], lopdf::StringFormat::Hexadecimal);
        let image = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => Object::Array(vec![
                    "Indexed".into(),
                    "DeviceRGB".into(),
                    1.into(),
                    palette,
                ]),
                "BitsPerComponent" => 8,
                "SMask" => smask,
            },
            vec![1],
        )));
        dictionary! {
            "XObject" => dictionary! { "Im0" => image },
        }
    });
    set_page_blend_space(&mut layered_doc, "DeviceRGB");
    let flat_content = format!(
        "{} {} {} rg 0 0 {PAGE} {PAGE} re f",
        mixed[0], mixed[1], mixed[2]
    );
    let mut flat_doc = build_with(&flat_content, |_doc| Dictionary::new());
    set_page_blend_space(&mut flat_doc, "DeviceRGB");
    let (Some(layered), Some(flat)) = (managed_render(&layered_doc), managed_render(&flat_doc))
    else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };
    let (x, y) = mid(&layered);
    for ch in 0..4 {
        let actual = px(&layered, ch, x, y);
        let expected = px(&flat, ch, x, y);
        assert!(
            (actual as i16 - expected as i16).abs() <= 1,
            "channel {ch}: layered={actual}, flat={expected}"
        );
    }
    assert!(!layered.warnings.ink_unsound(), "{:?}", layered.warnings);
}

#[test]
fn smask_matte_matches_unassociated_reference() {
    fn build_image(samples: [u8; 3], matte: Option<[f32; 3]>) -> Document {
        let content = format!(
            "0.01 0 0 rg 0 0 {PAGE} {PAGE} re f\n\
             q {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q"
        );
        let mut doc = build_with(&content, |doc| {
            let mut mask_dict = dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => 1, "Height" => 1,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            };
            if let Some(matte) = matte {
                mask_dict.set(
                    "Matte",
                    vec![matte[0].into(), matte[1].into(), matte[2].into()],
                );
            }
            let smask = Object::Reference(doc.add_object(Stream::new(mask_dict, vec![128])));
            let image = Object::Reference(doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => 1, "Height" => 1,
                    "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
                    "SMask" => smask,
                },
                samples.to_vec(),
            )));
            dictionary! { "XObject" => dictionary! { "Im0" => image } }
        });
        set_page_blend_space(&mut doc, "DeviceRGB");
        doc
    }

    // Đỏ chưa associated [255,0,0] và cùng đỏ đã preblend lên matte trắng
    // [255,128,128] phải cho cùng kết quả khi alpha = 128/255.
    let associated = build_image([255, 128, 128], Some([1.0, 1.0, 1.0]));
    let reference = build_image([255, 0, 0], None);
    let (Some(actual), Some(expected)) = (managed_render(&associated), managed_render(&reference))
    else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };
    let (x, y) = mid(&actual);
    for channel in 0..4 {
        let a = px(&actual, channel, x, y);
        let e = px(&expected, channel, x, y);
        assert!(
            (a as i16 - e as i16).abs() <= 1,
            "channel {channel}: Matte={a}, reference={e}"
        );
    }
    assert!(!actual.warnings.ink_unsound(), "{:?}", actual.warnings);
}

#[test]
fn managed_rgb_shading_alpha_blends_before_icc() {
    let background = [0.1f32, 0.2, 0.3];
    // Tâm pixel x=20.5 được LUT 256 ô làm tròn về chỉ số 131.
    let t = 131.0f32 / 255.0;
    let source = [0.2 + 0.4 * t, 0.4 - 0.2 * t, 0.6 - 0.2 * t];
    let mixed = [
        background[0] * 0.6 + source[0] * 0.4,
        background[1] * 0.6 + source[1] * 0.4,
        background[2] * 0.6 + source[2] * 0.4,
    ];
    let layered_content = format!("0.1 0.2 0.3 rg 0 0 {PAGE} {PAGE} re f\n/GS0 gs /Sh0 sh");
    let mut layered_doc = build_with(&layered_content, |_doc| {
        dictionary! {
            "Shading" => dictionary! {
                "Sh0" => dictionary! {
                    "ShadingType" => 2,
                    "ColorSpace" => "DeviceRGB",
                    "Coords" => vec![0.into(), 0.into(), PAGE.into(), 0.into()],
                    "Function" => dictionary! {
                        "FunctionType" => 2,
                        "Domain" => vec![0.into(), 1.into()],
                        "C0" => vec![0.2.into(), 0.4.into(), 0.6.into()],
                        "C1" => vec![0.6.into(), 0.2.into(), 0.4.into()],
                        "N" => 1,
                    },
                    "Extend" => vec![Object::Boolean(true), Object::Boolean(true)],
                }
            },
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "BM" => "Normal", "ca" => 0.4 }
            },
        }
    });
    set_page_blend_space(&mut layered_doc, "DeviceRGB");
    let flat_content = format!(
        "{} {} {} rg 0 0 {PAGE} {PAGE} re f",
        mixed[0], mixed[1], mixed[2]
    );
    let mut flat_doc = build_with(&flat_content, |_doc| Dictionary::new());
    set_page_blend_space(&mut flat_doc, "DeviceRGB");
    let (Some(layered), Some(flat)) = (managed_render(&layered_doc), managed_render(&flat_doc))
    else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };
    let (x, y) = mid(&layered);
    for ch in 0..4 {
        let actual = px(&layered, ch, x, y);
        let expected = px(&flat, ch, x, y);
        assert!(
            (actual as i16 - expected as i16).abs() <= 1,
            "channel {ch}: layered={actual}, flat={expected}"
        );
    }
    assert!(!layered.warnings.ink_unsound(), "{:?}", layered.warnings);
}

#[test]
fn managed_device_gray_backdrop_on_rgb_page_stays_in_rgb_space() {
    let gray = 0.25f32;
    let source = [0.6f32, 0.2, 0.4];
    let mixed = [
        gray * 0.6 + source[0] * 0.4,
        gray * 0.6 + source[1] * 0.4,
        gray * 0.6 + source[2] * 0.4,
    ];
    let layered_content = format!(
        "{gray} g 0 0 {PAGE} {PAGE} re f\n\
         /GS0 gs {} {} {} rg 0 0 {PAGE} {PAGE} re f",
        source[0], source[1], source[2]
    );
    let mut layered_doc = build_with(&layered_content, |_doc| {
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "BM" => "Normal", "ca" => 0.4 }
            }
        }
    });
    set_page_blend_space(&mut layered_doc, "DeviceRGB");

    let flat_content = format!(
        "{} {} {} rg 0 0 {PAGE} {PAGE} re f",
        mixed[0], mixed[1], mixed[2]
    );
    let mut flat_doc = build_with(&flat_content, |_doc| Dictionary::new());
    set_page_blend_space(&mut flat_doc, "DeviceRGB");
    let (Some(layered), Some(flat)) = (managed_render(&layered_doc), managed_render(&flat_doc))
    else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };

    let (x, y) = mid(&layered);
    for ch in 0..4 {
        let actual = px(&layered, ch, x, y);
        let expected = px(&flat, ch, x, y);
        assert!(
            (actual as i16 - expected as i16).abs() <= 1,
            "channel {ch}: layered={actual}, flat={expected}"
        );
    }
    assert!(!layered.warnings.ink_unsound(), "{:?}", layered.warnings);
}
#[test]
fn managed_non_isolated_rgb_group_keeps_rgb_backdrop() {
    let background = [0.1f32, 0.2, 0.3];
    let source = [0.0f32, 0.0, 1.0];
    let mixed = [
        background[0] * 0.8 + source[0] * 0.2,
        background[1] * 0.8 + source[1] * 0.2,
        background[2] * 0.8 + source[2] * 0.2,
    ];
    let page_content = format!(
        "{} {} {} rg 0 0 {PAGE} {PAGE} re f\n/GSOuter gs /Fm0 Do",
        background[0], background[1], background[2]
    );
    let mut layered_doc = build_with(&page_content, |doc| {
        let form_resources = doc.add_object(dictionary! {
            "ExtGState" => dictionary! {
                "GSInner" => dictionary! { "BM" => "Normal", "ca" => 0.5 }
            }
        });
        let form_content = format!("/GSInner gs 0 0 1 rg 0 0 {PAGE} {PAGE} re f");
        let form = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "Group" => Object::Dictionary(dictionary! {
                    "S" => "Transparency",
                    "I" => Object::Boolean(false),
                    "K" => Object::Boolean(false),
                }),
                "Resources" => Object::Reference(form_resources),
            },
            form_content.as_bytes().to_vec(),
        )));
        dictionary! {
            "XObject" => dictionary! { "Fm0" => form },
            "ExtGState" => dictionary! {
                "GSOuter" => dictionary! { "BM" => "Normal", "ca" => 0.4 }
            },
        }
    });
    set_page_blend_space(&mut layered_doc, "DeviceRGB");

    let flat_content = format!(
        "{} {} {} rg 0 0 {PAGE} {PAGE} re f",
        mixed[0], mixed[1], mixed[2]
    );
    let mut flat_doc = build_with(&flat_content, |_doc| Dictionary::new());
    set_page_blend_space(&mut flat_doc, "DeviceRGB");
    let (Some(layered), Some(flat)) = (managed_render(&layered_doc), managed_render(&flat_doc))
    else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };

    let (x, y) = mid(&layered);
    for ch in 0..4 {
        let actual = px(&layered, ch, x, y);
        let expected = px(&flat, ch, x, y);
        assert!(
            (actual as i16 - expected as i16).abs() <= 1,
            "channel {ch}: layered={actual}, flat={expected}"
        );
    }
    assert!(!layered.warnings.ink_unsound(), "{:?}", layered.warnings);
}

#[test]
fn managed_page_without_group_uses_cmyk_target_blending() {
    let background = [0.1f32, 0.2, 0.3];
    let source = [0.6f32, 0.2, 0.4];
    let content = format!(
        "{} {} {} rg 0 0 {PAGE} {PAGE} re f\n\
         /GS0 gs {} {} {} rg 0 0 {PAGE} {PAGE} re f",
        background[0], background[1], background[2], source[0], source[1], source[2],
    );
    let doc = build_with(&content, |_doc| {
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "BM" => "Normal", "ca" => 0.4 }
            }
        }
    });
    let Some(rendered) = managed_render(&doc) else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let cm = ColorManager::from_profiles(
        &root.join("backend/app/assets/icc/FOGRA39.icc"),
        Some(&root.join("backend/app/assets/icc/sRGB.icc")),
        RenderIntent::RelativeColorimetric,
    )
    .expect("profile kiểm thử phải đọc được");
    let background_ink = cm
        .rgb_to_cmyk(background[0], background[1], background[2])
        .unwrap();
    let source_ink = cm.rgb_to_cmyk(source[0], source[1], source[2]).unwrap();
    let (x, y) = mid(&rendered);
    for ch in 0..4 {
        let expected = ((background_ink[ch] * 0.6 + source_ink[ch] * 0.4) * 255.0).round() as i16;
        let actual = px(&rendered, ch, x, y) as i16;
        assert!(
            (actual - expected).abs() <= 1,
            "channel {ch}: {actual} vs {expected}"
        );
    }
    assert!(!rendered.warnings.ink_unsound(), "{:?}", rendered.warnings);
}

#[test]
fn managed_isolated_rgb_group_blends_with_group_alpha_before_icc() {
    let form_content = format!(
        "/GS0 gs 1 0 0 rg 0 0 {PAGE} {PAGE} re f\n\
         /GS1 gs 0 0 1 rg 0 0 {PAGE} {PAGE} re f"
    );
    let doc = build_with("/Fm0 Do", |doc| {
        let form_resources = doc.add_object(dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "BM" => "Normal", "ca" => 0.25 },
                "GS1" => dictionary! { "BM" => "Normal", "ca" => 0.5 },
            }
        });
        let form = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "Group" => Object::Dictionary(dictionary! {
                    "S" => "Transparency",
                    "CS" => "DeviceRGB",
                    "I" => Object::Boolean(true),
                    "K" => Object::Boolean(false),
                }),
                "Resources" => Object::Reference(form_resources),
            },
            form_content.as_bytes().to_vec(),
        )));
        dictionary! { "XObject" => dictionary! { "Fm0" => form } }
    });
    let Some(rendered) = managed_render(&doc) else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let cmyk = root.join("backend/app/assets/icc/FOGRA39.icc");
    let rgb = root.join("backend/app/assets/icc/sRGB.icc");
    let cm = ColorManager::from_profiles(&cmyk, Some(&rgb), RenderIntent::RelativeColorimetric)
        .expect("profile kiểm thử phải đọc được");
    let group_color = cm
        .rgb_to_cmyk(0.2, 0.0, 0.8)
        .expect("RGB group phải đổi được sang CMYK");
    let (x, y) = mid(&rendered);
    for (ch, value) in group_color.iter().enumerate() {
        let expected = (value * 0.625 * 255.0).round() as i16;
        let actual = px(&rendered, ch, x, y) as i16;
        assert!(
            (actual - expected).abs() <= 1,
            "channel {ch}: actual={actual}, expected={expected}"
        );
    }
    assert!(
        !rendered.warnings.unsupported_transparency,
        "{:?}",
        rendered.warnings
    );
    assert!(!rendered.warnings.ink_unsound(), "{:?}", rendered.warnings);
}

#[test]
fn isolated_rgb_group_with_non_rgb_content_stays_fail_loud() {
    let form_content = format!("0 1 0 0 k 0 0 {PAGE} {PAGE} re f");
    let doc = build_with("/Fm0 Do", |doc| {
        let form = Object::Reference(doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "Group" => Object::Dictionary(dictionary! {
                    "S" => "Transparency",
                    "CS" => "DeviceRGB",
                    "I" => Object::Boolean(true),
                    "K" => Object::Boolean(false),
                }),
            },
            form_content.as_bytes().to_vec(),
        )));
        dictionary! { "XObject" => dictionary! { "Fm0" => form } }
    });
    let Some(rendered) = managed_render(&doc) else {
        eprintln!("bỏ qua: không có profile ICC kiểm thử");
        return;
    };
    assert!(rendered.warnings.unsupported_transparency);
    assert!(rendered
        .warnings
        .skipped_ops
        .iter()
        .any(|(op, _)| { op.contains("Group DeviceRGB isolated") }));
    assert!(rendered.warnings.ink_unsound());
}
