//! Test tích hợp cho ảnh XObject.
//!
//! Ảnh là nơi dễ sai âm thầm nhất của một RIP: lộn trên-dưới, đảo `/Decode`,
//! nhầm chỉ số bảng màu với cường độ, bỏ predictor. Mọi lỗi đó đều cho ra file
//! "render thành công" nên chỉ test mới bắt được.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

/// Dựng PDF một trang 10x10 point với content + resources cho trước.
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
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
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

/// Dựng PDF vẽ một ảnh phủ kín trang.
fn render_image(image_dict: Dictionary, data: Vec<u8>) -> PageRender {
    let mut doc = Document::with_version("1.7");
    let img_id = doc.add_object(Stream::new(image_dict, data));
    let resources = dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    };
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let resources_id = doc.add_object(resources);
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn base_image(w: i64, h: i64, bpc: i64, cs: &str) -> Dictionary {
    dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => w,
        "Height" => h,
        "BitsPerComponent" => bpc,
        "ColorSpace" => cs,
    }
}

fn px(r: &PageRender, channel: usize, x: usize, y: usize) -> u8 {
    r.buffer.plate_u8(channel)[y * r.buffer.width() as usize + x]
}

fn center(r: &PageRender) -> (usize, usize) {
    (r.buffer.width() as usize / 2, r.buffer.height() as usize / 2)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cơ bản
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn gray_image_black_becomes_k_only() {
    let r = render_image(base_image(1, 1, 8, "DeviceGray"), vec![0]);
    let (cx, cy) = center(&r);
    assert_eq!(px(&r, 3, cx, cy), 255, "K phải đặc");
    assert_eq!(px(&r, 0, cx, cy), 0, "Cyan phải trắng");
}

#[test]
fn gray_image_white_leaves_no_ink() {
    let r = render_image(base_image(1, 1, 8, "DeviceGray"), vec![255]);
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
}

#[test]
fn cmyk_image_solid_measures_400_percent() {
    // Ảnh CMYK là lượng mực thật trong file — TAC phải đúng 400%.
    let r = render_image(base_image(1, 1, 8, "DeviceCMYK"), vec![255, 255, 255, 255]);
    assert!((r.buffer.max_tac_percent() - 400.0).abs() < 0.5);
}

#[test]
fn cmyk_image_is_not_flagged_as_approximate() {
    let r = render_image(base_image(1, 1, 8, "DeviceCMYK"), vec![0, 0, 0, 255]);
    assert!(!r.warnings.degrades_accuracy(), "{:?}", r.warnings);
    assert_eq!(r.warnings.dropped_objects, 0);
}

#[test]
fn rgb_image_is_flagged_as_approximate() {
    let r = render_image(base_image(1, 1, 8, "DeviceRGB"), vec![255, 0, 0]);
    assert!(r.warnings.degrades_accuracy(), "RGB không ICC phải hạ accuracy");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hướng và hình học
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn image_row_zero_lands_at_top_of_the_page() {
    // Hàng 0 của ảnh nằm ở ĐỈNH hình vuông đơn vị. Lộn chỗ này là lỗi in ngược
    // ảnh — rất khó thấy trên ảnh đối xứng và rất đắt khi phát hiện sau khi in.
    let r = render_image(base_image(1, 2, 8, "DeviceGray"), vec![0, 255]);
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 3, w / 2, 0), 255, "hàng 0 (đen) phải ở TRÊN");
    assert_eq!(px(&r, 3, w / 2, h - 1), 0, "hàng 1 (trắng) phải ở DƯỚI");
}

#[test]
fn image_columns_map_left_to_right() {
    let r = render_image(base_image(2, 1, 8, "DeviceGray"), vec![0, 255]);
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 3, 0, h / 2), 255, "cột 0 (đen) ở BÊN TRÁI");
    assert_eq!(px(&r, 3, w - 1, h / 2), 0);
}

#[test]
fn image_is_confined_to_the_unit_square_after_cm() {
    // Ảnh chỉ chiếm nửa trái trang; nửa phải phải trắng.
    let mut doc = Document::with_version("1.7");
    let img_id = doc.add_object(Stream::new(base_image(1, 1, 8, "DeviceGray"), vec![0]));
    let resources = dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    };
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 5 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let resources_id = doc.add_object(resources);
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 3, 1, h / 2), 255, "trong ảnh");
    assert_eq!(px(&r, 3, w - 1, h / 2), 0, "ngoài ảnh phải trắng");
}

#[test]
fn degenerate_ctm_draws_nothing_without_panicking() {
    let mut doc = Document::with_version("1.7");
    let img_id = doc.add_object(Stream::new(base_image(1, 1, 8, "DeviceGray"), vec![0]));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    });
    // Ma trận scale 0 — suy biến, không khả nghịch.
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"q 0 0 0 0 0 0 cm /Im0 Do Q".to_vec()));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Decode, bit depth, bảng màu
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn decode_array_inverts_the_image() {
    let mut dict = base_image(1, 1, 8, "DeviceGray");
    dict.set("Decode", vec![1.into(), 0.into()]);
    // Mẫu 255 (trắng) + Decode đảo ⇒ phải ra ĐEN.
    let r = render_image(dict, vec![255]);
    let (cx, cy) = center(&r);
    assert_eq!(px(&r, 3, cx, cy), 255);
}

#[test]
fn one_bit_image_rows_start_on_byte_boundary() {
    // Ảnh 3x2, 1 bit: nếu không tôn trọng ranh giới byte mỗi hàng, ảnh sẽ xiên.
    // Hàng 1 = 101, hàng 2 = 010 (0 = đen với DeviceGray).
    let r = render_image(
        base_image(3, 2, 1, "DeviceGray"),
        vec![0b1010_0000, 0b0100_0000],
    );
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    // Hàng trên: cột giữa là 0 → đen.
    assert_eq!(px(&r, 3, w / 2, 1), 255, "hàng trên, cột giữa phải đen");
    // Hàng dưới: cột giữa là 1 → trắng.
    assert_eq!(px(&r, 3, w / 2, h - 2), 0, "hàng dưới, cột giữa phải trắng");
}

#[test]
fn four_bit_image_scales_full_range() {
    // 0x0F: pixel đầu 0 (đen), pixel sau 15 (trắng).
    let r = render_image(base_image(2, 1, 4, "DeviceGray"), vec![0x0F]);
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 3, 0, h / 2), 255);
    assert_eq!(px(&r, 3, w - 1, h / 2), 0);
}

#[test]
fn indexed_palette_is_looked_up_not_treated_as_intensity() {
    // Palette 2 màu CMYK: 0 = trắng, 1 = 100% Cyan.
    // Nếu engine coi chỉ số là cường độ thì pixel index=1 sẽ ra gần trắng.
    let mut doc = Document::with_version("1.7");
    let palette: Vec<u8> = vec![0, 0, 0, 0, 255, 0, 0, 0];
    let cs = Object::Array(vec![
        "Indexed".into(),
        "DeviceCMYK".into(),
        Object::Integer(1),
        Object::String(palette, lopdf::StringFormat::Hexadecimal),
    ]);
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 8,
    };
    dict.set("ColorSpace", cs);
    let img_id = doc.add_object(Stream::new(dict, vec![1]));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec()));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let (cx, cy) = center(&r);
    assert_eq!(px(&r, 0, cx, cy), 255, "index 1 phải tra ra 100% Cyan");
    assert_eq!(px(&r, 3, cx, cy), 0);
}

#[test]
fn indexed_image_below_8bpc_keeps_palette_indices() {
    // Hồi quy cho một bug đã xảy ra: mẫu Indexed từng bị trải ra thang 0..255
    // như cường độ, nên với ảnh 4 bit chỉ số 1 thành 17 và trỏ sai ô bảng màu.
    // Chỉ số 0 và chỉ số lớn nhất vẫn đúng, nên MAE trung bình vẫn đẹp và chỉ
    // đỉnh TAC mới lộ ra — đúng loại lỗi cần test riêng.
    //
    // Palette 16 ô: ô 1 = 100% Magenta, các ô khác trắng, ô 15 = 100% Cyan.
    let mut palette = vec![0u8; 16 * 4];
    palette[1 * 4 + 1] = 255; // ô 1: M = 100%
    palette[15 * 4 + 0] = 255; // ô 15: C = 100%

    let cs = Object::Array(vec![
        "Indexed".into(),
        "DeviceCMYK".into(),
        Object::Integer(15),
        Object::String(palette, lopdf::StringFormat::Hexadecimal),
    ]);
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 2,
        "Height" => 1,
        "BitsPerComponent" => 4,
    };
    dict.set("ColorSpace", cs);
    // Hai pixel 4 bit trong một byte: chỉ số 1 rồi chỉ số 15.
    let r = render_image(dict, vec![0x1F]);

    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 1, 0, h / 2), 255, "pixel chỉ số 1 phải là Magenta 100%");
    assert_eq!(px(&r, 0, 0, h / 2), 0, "và không có Cyan");
    assert_eq!(px(&r, 0, w - 1, h / 2), 255, "pixel chỉ số 15 phải là Cyan 100%");
    assert_eq!(px(&r, 1, w - 1, h / 2), 0);
}

#[test]
fn flate_image_with_png_predictor_decodes_correctly() {
    // Đây chính là trường hợp lopdf không lo được: thiếu predictor thì ra nhiễu.
    use flate2::write::ZlibEncoder;
    use std::io::Write;

    // 2 hàng × 2 pixel gray. Hàng 1 filter 0: [0, 255]. Hàng 2 filter 2 (up): [0,0]
    // ⇒ hàng 2 = hàng 1.
    let raw = vec![0u8, 0, 255, 2, 0, 0];
    let mut e = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(&raw).unwrap();
    let compressed = e.finish().unwrap();

    let mut dict = base_image(2, 2, 8, "DeviceGray");
    dict.set("Filter", "FlateDecode");
    dict.set(
        "DecodeParms",
        dictionary! { "Predictor" => 15, "Colors" => 1, "BitsPerComponent" => 8, "Columns" => 2 },
    );
    let r = render_image(dict, compressed);

    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 3, 0, 1), 255, "trên-trái đen");
    assert_eq!(px(&r, 3, w - 1, 1), 0, "trên-phải trắng");
    assert_eq!(px(&r, 3, 0, h - 2), 255, "dưới-trái phải giống hàng trên");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Stencil và alpha
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn image_mask_paints_with_current_fill_colour() {
    // `/ImageMask true`: ảnh là khuôn, màu lấy từ trạng thái tô hiện hành.
    let mut doc = Document::with_version("1.7");
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 2,
        "Height" => 1,
        "BitsPerComponent" => 1,
    };
    dict.set("ImageMask", Object::Boolean(true));
    // 0b01000000: pixel 0 = 0 (TÔ), pixel 1 = 1 (không tô).
    let img_id = doc.add_object(Stream::new(dict, vec![0b0100_0000]));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    });
    // Màu tô: 100% Magenta.
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"0 1 0 0 k q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 1, 0, h / 2), 255, "pixel 0 phải tô Magenta");
    assert_eq!(px(&r, 1, w - 1, h / 2), 0, "pixel 1 không được tô");
}

#[test]
fn soft_mask_scales_ink() {
    // SMask xám 50% ⇒ mực còn một nửa.
    let mut doc = Document::with_version("1.7");
    let smask_id = doc.add_object(Stream::new(base_image(1, 1, 8, "DeviceGray"), vec![128]));
    let mut dict = base_image(1, 1, 8, "DeviceGray");
    dict.set("SMask", Object::Reference(smask_id));
    let img_id = doc.add_object(Stream::new(dict, vec![0])); // đen
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec()));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let (cx, cy) = center(&r);
    let v = px(&r, 3, cx, cy);
    assert!((v as i32 - 128).abs() <= 3, "v={v}");
}

#[test]
fn image_respects_clip() {
    let mut doc = Document::with_version("1.7");
    let img_id = doc.add_object(Stream::new(base_image(1, 1, 8, "DeviceGray"), vec![0]));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"0 0 5 10 re W n q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 3, 1, h / 2), 255, "trong clip");
    assert_eq!(px(&r, 3, w - 1, h / 2), 0, "ngoài clip");
}

#[test]
fn cmyk_image_overprint_mode_1_keeps_background_channels() {
    // Hồi quy: đường ảnh dựng `InkPaint` trực tiếp nên từng bỏ sót ngữ nghĩa
    // `OPM = 1`. Ảnh CMYK có C=M=Y=0 overprint lên nền Cyan phải KHÔNG khoét nền.
    let mut doc = Document::with_version("1.7");
    let img_id = doc.add_object(Stream::new(
        base_image(1, 1, 8, "DeviceCMYK"),
        vec![0, 0, 0, 255],
    ));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
        "ExtGState" => dictionary! { "GS" => dictionary! { "op" => true, "OPM" => 1 } },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"1 0 0 0 k 0 0 10 10 re f /GS gs q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let (cx, cy) = center(&r);
    assert_eq!(px(&r, 0, cx, cy), 255, "OPM=1 phải giữ Cyan nền");
    assert_eq!(px(&r, 3, cx, cy), 255);
    assert!((r.buffer.max_tac_percent() - 200.0).abs() < 0.5);
}

#[test]
fn image_honours_overprint() {
    // Ảnh K-only overprint trên nền Cyan: Cyan phải còn.
    let mut doc = Document::with_version("1.7");
    let img_id = doc.add_object(Stream::new(base_image(1, 1, 8, "DeviceGray"), vec![0]));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
        "ExtGState" => dictionary! { "GS" => dictionary! { "op" => true, "OPM" => 1 } },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"1 0 0 0 k 0 0 10 10 re f /GS gs q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let pages_object_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_object_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let (cx, cy) = center(&r);
    assert_eq!(px(&r, 0, cx, cy), 255, "overprint phải giữ Cyan nền");
    assert_eq!(px(&r, 3, cx, cy), 255);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fail loud
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn unsupported_codec_is_reported_not_silently_skipped() {
    let mut dict = base_image(1, 1, 8, "DeviceGray");
    dict.set("Filter", "JPXDecode");
    let r = render_image(dict, vec![0, 0, 0]);
    assert!(r.warnings.dropped_objects > 0);
    assert!(r.warnings.degrades_accuracy());
    assert!(
        r.warnings.skipped_ops.iter().any(|(op, _)| op.contains("JPX")),
        "{:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn image_missing_colorspace_is_reported() {
    let dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 8,
    };
    let r = render_image(dict, vec![0]);
    assert!(r.warnings.dropped_objects > 0);
}

#[test]
fn absurd_image_dimensions_are_rejected_before_allocating() {
    let mut dict = base_image(1, 1, 8, "DeviceGray");
    dict.set("Width", Object::Integer(1_000_000));
    dict.set("Height", Object::Integer(1_000_000));
    let r = render_image(dict, vec![0]);
    assert!(r.warnings.dropped_objects > 0, "phải từ chối, không được OOM");
}

#[test]
fn content_without_images_still_renders() {
    // Bảo đảm phần dựng test không tự làm hỏng đường vector.
    let doc = build("0 0 0 1 k 0 0 10 10 re f", dictionary! {});
    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert!((r.buffer.max_tac_percent() - 100.0).abs() < 0.5);
}
