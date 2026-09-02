//! Test tích hợp shading (gradient).
//!
//! Trọng tâm là những thứ ảnh hưởng **lượng mực**, không phải "gradient có mượt
//! không": hướng dải chuyển, `/Extend`, vùng bị giới hạn bởi clip hay bởi đường
//! dẫn, và việc kiểu lưới chưa dựng phải bị **báo** chứ không được vẽ xấp xỉ.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::color::space::OutputPreviewFilter;
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 100;

fn build(content: &str, resources: Dictionary) -> Document {
    let mut doc = Document::with_version("1.7");
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

fn render(content: &str, resources: Dictionary) -> PageRender {
    let doc = build(content, resources);
    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn render_form_with_pattern(
    page_content: &str,
    form_content: &str,
    form_resources: Dictionary,
) -> PageRender {
    let mut doc = Document::with_version("1.7");
    let form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "Resources" => Object::Dictionary(form_resources),
        },
        form_content.as_bytes().to_vec(),
    ));
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        page_content.as_bytes().to_vec(),
    ));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Fm0" => Object::Reference(form_id) },
    });
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
    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render form phải thành công")
}

/// Hàm màu: K từ 0% tới 100%.
fn k_ramp() -> Dictionary {
    dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
        "N" => 1,
        "Range" => vec![
            0.into(), 1.into(), 0.into(), 1.into(),
            0.into(), 1.into(), 0.into(), 1.into(),
        ],
    }
}

fn axial(extend: Option<[bool; 2]>) -> Dictionary {
    let mut d = dictionary! {
        "ShadingType" => 2,
        "ColorSpace" => "DeviceCMYK",
        "Coords" => vec![0.into(), 0.into(), PAGE.into(), 0.into()],
        "Function" => Object::Dictionary(k_ramp()),
    };
    if let Some(e) = extend {
        d.set(
            "Extend",
            Object::Array(vec![Object::Boolean(e[0]), Object::Boolean(e[1])]),
        );
    }
    d
}

fn render_with_options(content: &str, resources: Dictionary, options: RenderOptions) -> PageRender {
    let doc = build(content, resources);
    render_page(&doc, 1, 72.0, PageBox::Crop, options).expect("render phải thành công")
}

fn spot_axial() -> Dictionary {
    let separation = Object::Array(vec![
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
    dictionary! {
        "ShadingType" => 2,
        "ColorSpace" => separation,
        "Coords" => vec![0.into(), 0.into(), PAGE.into(), 0.into()],
        "Function" => dictionary! {
            "FunctionType" => 2,
            "Domain" => vec![0.into(), 1.into()],
            "C0" => vec![0.into()],
            "C1" => vec![1.into()],
            "N" => 1,
            "Range" => vec![0.into(), 1.into()],
        },
    }
}

fn shading_res(shading: Dictionary) -> Dictionary {
    dictionary! { "Shading" => dictionary! { "Sh0" => Object::Dictionary(shading) } }
}

fn px(r: &PageRender, channel: usize, x: usize, y: usize) -> u8 {
    r.buffer.plate_u8(channel)[y * r.buffer.width() as usize + x]
}

// ─────────────────────────────────────────────────────────────────────────────
//  Operator `sh`
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn axial_shading_paints_a_gradient_across_the_page() {
    let r = render("/Sh0 sh", shading_res(axial(None)));
    let h = r.buffer.height() as usize / 2;
    let w = r.buffer.width() as usize;
    let left = px(&r, 3, 1, h);
    let mid = px(&r, 3, w / 2, h);
    let right = px(&r, 3, w - 2, h);
    assert!(left < 20, "đầu trục phải gần như không mực: {left}");
    assert!((mid as i32 - 128).abs() < 20, "giữa phải ~50% mực: {mid}");
    assert!(right > 235, "cuối trục phải gần đặc: {right}");
}

#[test]
fn axial_shading_is_constant_perpendicular_to_the_axis() {
    // Trục ngang ⇒ mọi hàng phải giống nhau. Lệch nghĩa là nhầm trục.
    let r = render("/Sh0 sh", shading_res(axial(None)));
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    let a = px(&r, 3, w / 2, 2);
    let b = px(&r, 3, w / 2, h - 3);
    assert!((a as i32 - b as i32).abs() <= 1, "a={a} b={b}");
}

#[test]
fn shading_only_touches_declared_channel() {
    let r = render("/Sh0 sh", shading_res(axial(None)));
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert_eq!(px(&r, 0, w - 2, h), 0, "Cyan phải trắng");
    assert_eq!(px(&r, 1, w - 2, h), 0);
    assert_eq!(px(&r, 2, w - 2, h), 0);
}

#[test]
fn shading_without_extend_leaves_outside_untouched() {
    // Trục chỉ dài nửa trang, không extend ⇒ nửa phải phải trắng.
    let mut d = axial(None);
    d.set(
        "Coords",
        Object::Array(vec![0.into(), 0.into(), 50.into(), 0.into()]),
    );
    let r = render("/Sh0 sh", shading_res(d));
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert!(
        px(&r, 3, w - 2, h) == 0,
        "ngoài trục không extend phải trắng"
    );
}

#[test]
fn shading_with_extend_fills_beyond_the_axis() {
    // Bỏ qua `/Extend` làm dải chuyển kết thúc đột ngột ⇒ sai diện tích phủ mực.
    let mut d = axial(Some([true, true]));
    d.set(
        "Coords",
        Object::Array(vec![0.into(), 0.into(), 50.into(), 0.into()]),
    );
    let r = render("/Sh0 sh", shading_res(d));
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert!(
        px(&r, 3, w - 2, h) > 235,
        "extend phải phủ tiếp tới hết trang"
    );
}

#[test]
fn sh_respects_the_current_clip() {
    // `sh` không có đường dẫn nào giới hạn: vùng phủ CHÍNH LÀ clip.
    let r = render(
        "0 0 50 100 re W n /Sh0 sh",
        shading_res(axial(Some([true, true]))),
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert!(px(&r, 3, 2, h) < 20, "trong clip, đầu trục nhạt");
    assert!(px(&r, 3, w / 2 - 2, h) > 100, "trong clip, gần giữa đã đậm");
    assert_eq!(px(&r, 3, w - 2, h), 0, "ngoài clip phải trắng");
}

#[test]
fn output_preview_smooth_shades_filter_keeps_gradient_and_rejects_other_objects() {
    let smooth = render_with_options(
        "/Sh0 sh",
        shading_res(axial(None)),
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::SmoothShades),
    );
    assert!(
        smooth.buffer.max_tac_percent() > 90.0,
        "Show=Smooth Shades phải giữ gradient"
    );

    for filter in [
        OutputPreviewFilter::Text,
        OutputPreviewFilter::Images,
        OutputPreviewFilter::LineArt,
    ] {
        let hidden = render_with_options(
            "/Sh0 sh",
            shading_res(axial(None)),
            RenderOptions::softproof().with_output_preview_filter(filter),
        );
        assert_eq!(
            hidden.buffer.max_tac_percent(),
            0.0,
            "{filter:?} không được giữ gradient"
        );
    }
}

#[test]
fn q_q_restores_the_shading_clip_region() {
    let r = render(
        "q 0 0 10 100 re W n Q /Sh0 sh",
        shading_res(axial(Some([true, true]))),
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert!(
        px(&r, 3, w - 2, h) > 235,
        "Q phải phục hồi cả clip thật lẫn hộp bao dùng để giới hạn vòng lặp"
    );
}

#[test]
fn empty_clip_still_registers_shading_spot_colorant() {
    // Dù không có pixel để tô, LUT vẫn phải được dựng: đây là lúc kênh spot
    // được đăng ký và cảnh báo màu được thu thập.
    let r = render("W n /Sh0 sh", shading_res(spot_axial()));
    let names: Vec<&str> = r
        .buffer
        .space()
        .colorants()
        .iter()
        .map(|colorant| colorant.name())
        .collect();
    assert!(names.contains(&"PANTONE 485 C"), "{names:?}");
    assert_eq!(
        r.buffer.max_tac_percent(),
        0.0,
        "clip rỗng không được lên mực"
    );
}

#[test]
fn radial_shading_paints_from_centre_outwards() {
    let d = dictionary! {
        "ShadingType" => 3,
        "ColorSpace" => "DeviceCMYK",
        // Tâm trang, bán kính 0 → 50.
        "Coords" => vec![50.into(), 50.into(), 0.into(), 50.into(), 50.into(), 50.into()],
        "Function" => Object::Dictionary(k_ramp()),
    };
    let r = render("/Sh0 sh", shading_res(d));
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    let centre = px(&r, 3, w / 2, h / 2);
    let edge = px(&r, 3, w / 2, 2);
    assert!(centre < 20, "tâm phải nhạt: {centre}");
    assert!(edge > 200, "biên phải đậm: {edge}");
}

#[test]
fn radial_outside_outer_circle_is_untouched_without_extend() {
    let d = dictionary! {
        "ShadingType" => 3,
        "ColorSpace" => "DeviceCMYK",
        "Coords" => vec![50.into(), 50.into(), 0.into(), 50.into(), 50.into(), 20.into()],
        "Function" => Object::Dictionary(k_ramp()),
    };
    let r = render("/Sh0 sh", shading_res(d));
    // Góc trang cách tâm ~70 > 20 ⇒ ngoài vòng ngoài.
    assert_eq!(px(&r, 3, 1, 1), 0);
}

#[test]
fn shading_bbox_limits_the_painted_area() {
    let mut d = axial(Some([true, true]));
    d.set(
        "BBox",
        Object::Array(vec![0.into(), 0.into(), 50.into(), 100.into()]),
    );
    let r = render("/Sh0 sh", shading_res(d));
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert!(px(&r, 3, 2, h) < 20 || px(&r, 3, 2, h) > 0);
    assert_eq!(px(&r, 3, w - 2, h), 0, "ngoài BBox phải trắng");
}

#[test]
fn clean_shading_page_is_not_flagged_degraded() {
    // Đây là điểm của cả milestone: trang gradient không còn bị hạ độ tin cậy.
    let r = render("/Sh0 sh", shading_res(axial(None)));
    assert!(!r.warnings.degrades_accuracy(), "{:?}", r.warnings);
    assert_eq!(r.warnings.dropped_objects, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shading pattern qua `scn`
// ─────────────────────────────────────────────────────────────────────────────

fn pattern_res(shading: Dictionary) -> Dictionary {
    dictionary! {
        "Pattern" => dictionary! {
            "P0" => Object::Dictionary(dictionary! {
                "Type" => "Pattern",
                "PatternType" => 2,
                "Shading" => Object::Dictionary(shading),
            }),
        },
    }
}

#[test]
fn shading_pattern_fills_only_inside_the_path() {
    let r = render(
        "/Pattern cs /P0 scn 0 0 50 100 re f",
        pattern_res(axial(Some([true, true]))),
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert!(px(&r, 3, w / 2 - 2, h) > 100, "trong hình phải có mực");
    assert_eq!(px(&r, 3, w - 2, h), 0, "ngoài hình phải trắng");
}

#[test]
fn shading_pattern_produces_a_gradient_not_a_flat_fill() {
    // Tô một màu phẳng xấp xỉ sẽ cho lượng mực bịa; phải là dải chuyển thật.
    let r = render(
        "/Pattern cs /P0 scn 0 0 100 100 re f",
        pattern_res(axial(None)),
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    let left = px(&r, 3, 2, h);
    let right = px(&r, 3, w - 2, h);
    assert!(
        right as i32 - left as i32 > 200,
        "left={left} right={right}"
    );
}

#[test]
fn shading_pattern_uses_the_enclosing_stream_initial_matrix() {
    // Form được thu 0.5× và dịch sang giữa trang. `cm 2×` bên trong form
    // chỉ phóng đường dẫn; nó không được phóng pattern lần nữa. Pattern
    // `/Matrix` phải ghép với CTM khởi đầu của form, không phải CTM đầu
    // trang và cũng không phải CTM sau `cm` của form.
    let r = render_form_with_pattern(
        "q .5 0 0 .5 25 25 cm /Fm0 Do Q",
        "2 0 0 2 0 0 cm /Pattern cs /P0 scn 0 0 50 50 re f",
        pattern_res(axial(None)),
    );
    let y = r.buffer.height() as usize / 2;
    let left = px(&r, 3, 27, y);
    let mid = px(&r, 3, 50, y);
    let right = px(&r, 3, 73, y);
    assert!(left < 20, "gradient phải bắt đầu gần 0% K: {left}");
    assert!((mid as i32 - 128).abs() < 20, "giữa phải ~50% K: {mid}");
    assert!(right > 235, "gradient phải kết thúc gần 100% K: {right}");
}

#[test]
fn shading_pattern_honours_clip() {
    let r = render(
        "0 0 25 100 re W n /Pattern cs /P0 scn 0 0 100 100 re f",
        pattern_res(axial(Some([true, true]))),
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert!(px(&r, 3, 2, h) < 80, "trong clip");
    assert_eq!(px(&r, 3, w / 2, h), 0, "ngoài clip phải trắng");
}

#[test]
fn tiling_pattern_without_content_stream_is_reported_not_approximated() {
    // Pattern kiểu 1 khai bằng **dictionary** (không phải stream) là file hỏng: không
    // có ô nào để vẽ. Phải ghi nhận, không được tô một màu bịa rồi báo là tin được.
    // Tiling pattern hợp lệ được kiểm ở `tests/render_tiling_pattern.rs`.
    let res = dictionary! {
        "Pattern" => dictionary! {
            "P0" => Object::Dictionary(dictionary! {
                "Type" => "Pattern",
                "PatternType" => 1,
                "PaintType" => 1,
                "TilingType" => 1,
                "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "XStep" => 10,
                "YStep" => 10,
            }),
        },
    };
    let r = render("/Pattern cs /P0 scn 0 0 100 100 re f", res);
    assert_eq!(r.buffer.max_tac_percent(), 0.0, "không được tô màu bịa");
    assert!(r.warnings.dropped_objects > 0);
    assert!(r.warnings.degrades_accuracy());
}

#[test]
fn mesh_shading_is_reported_not_approximated() {
    let d = dictionary! {
        "ShadingType" => 4,
        "ColorSpace" => "DeviceCMYK",
        "Coords" => vec![0.into(), 0.into(), PAGE.into(), 0.into()],
    };
    let r = render("/Sh0 sh", shading_res(d));
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert!(r.warnings.dropped_objects > 0);
}

#[test]
fn pattern_name_left_over_does_not_leak_into_a_plain_fill() {
    // Sau khi `cs` đổi sang colorspace khác, tên pattern cũ còn trong trạng thái.
    // Dùng lại nó sẽ tô gradient lên hình đáng lẽ tô màu phẳng.
    let r = render(
        "/Pattern cs /P0 scn 0 0 0 1 k 0 0 100 100 re f",
        pattern_res(axial(None)),
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    // `k` đã đổi colorspace sang DeviceCMYK ⇒ phải là màu phẳng K 100%.
    assert_eq!(px(&r, 3, 2, h), 255);
    assert_eq!(px(&r, 3, w - 2, h), 255);
}

#[test]
fn shading_pattern_respects_overprint() {
    let mut res = pattern_res(axial(Some([true, true])));
    res.set(
        "ExtGState",
        Object::Dictionary(dictionary! {
            "GS" => dictionary! { "op" => true, "OPM" => 1 },
        }),
    );
    let r = render(
        "1 0 0 0 k 0 0 100 100 re f /GS gs /Pattern cs /P0 scn 0 0 100 100 re f",
        res,
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize / 2;
    assert_eq!(px(&r, 0, w - 2, h), 255, "overprint phải giữ Cyan nền");
    assert!(
        px(&r, 3, w - 2, h) > 200,
        "và vẫn thêm mực đen của gradient"
    );
}
