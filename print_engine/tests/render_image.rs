//! Test tích hợp cho ảnh XObject.
//!
//! Ảnh là nơi dễ sai âm thầm nhất của một RIP: lộn trên-dưới, đảo `/Decode`,
//! nhầm chỉ số bảng màu với cường độ, bỏ predictor. Mọi lỗi đó đều cho ra file
//! "render thành công" nên chỉ test mới bắt được.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::color::space::OutputPreviewFilter;
use print_engine::content::RenderOptions;
use print_engine::page::{
    render_page, render_page_managed_region, PageBox, PageRender, RasterClip,
};

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
    render_image_with_options(image_dict, data, RenderOptions::ink_accurate())
}

fn render_image_with_options(
    image_dict: Dictionary,
    data: Vec<u8>,
    options: RenderOptions,
) -> PageRender {
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

    render_page(&doc, 1, 72.0, PageBox::Crop, options).expect("render phải thành công")
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
    (
        r.buffer.width() as usize / 2,
        r.buffer.height() as usize / 2,
    )
}

#[test]
fn output_preview_images_filter_keeps_image_and_rejects_other_object_filters() {
    let images = render_image_with_options(
        base_image(1, 1, 8, "DeviceGray"),
        vec![0],
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::Images),
    );
    assert!(
        images.buffer.max_tac_percent() > 90.0,
        "Show=Images phải giữ ảnh"
    );

    for filter in [
        OutputPreviewFilter::Text,
        OutputPreviewFilter::LineArt,
        OutputPreviewFilter::SmoothShades,
    ] {
        let hidden = render_image_with_options(
            base_image(1, 1, 8, "DeviceGray"),
            vec![0],
            RenderOptions::softproof().with_output_preview_filter(filter),
        );
        assert_eq!(
            hidden.buffer.max_tac_percent(),
            0.0,
            "{filter:?} không được giữ ảnh"
        );
    }
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
fn softproof_minification_keeps_a_one_texel_cmyk_line() {
    // Hồi quy menu.pdf: ảnh nguồn 502 DPI bị thu khoảng 5,2× ở mức xem vừa trang.
    // Lấy duy nhất texel tâm làm nét chữ 1–2 texel biến mất. Fixture 60→10 px
    // đặt một sọc K ở cột đầu: đường đo mực giữ nearest cũ, còn soft-proof phải
    // tích phân footprint và giữ tín hiệu K trong pixel màn hình đầu; lớp tăng
    // chi tiết được phép điều chỉnh nhẹ nhưng không được làm nét biến mất.
    let mut samples = Vec::with_capacity(60 * 60 * 4);
    for _y in 0..60 {
        for x in 0..60 {
            samples.extend_from_slice(if x == 0 {
                &[255, 255, 255, 0]
            } else {
                &[255, 255, 255, 255]
            });
        }
    }
    let mut image = base_image(60, 60, 8, "DeviceCMYK");
    // Adobe CMYK JPEG thường dùng đúng Decode đảo này như menu.pdf.
    image.set(
        "Decode",
        vec![
            1.into(),
            0.into(),
            1.into(),
            0.into(),
            1.into(),
            0.into(),
            1.into(),
            0.into(),
        ],
    );

    let measured = render_image_with_options(
        image.clone(),
        samples.clone(),
        RenderOptions::ink_accurate(),
    );
    assert_eq!(px(&measured, 3, 0, 5), 0, "đường đo phải giữ nearest cũ");

    let preview = render_image_with_options(image, samples, RenderOptions::softproof());
    let first_pixel_k = px(&preview, 3, 0, 5);
    assert!(
        (28..=43).contains(&first_pixel_k),
        "sọc một texel phải còn trong footprint, K={first_pixel_k}"
    );
    assert_eq!(px(&preview, 3, 1, 5), 0, "không được làm nở sang pixel kế");
}

#[test]
fn rgb_image_is_flagged_as_approximate() {
    let r = render_image(base_image(1, 1, 8, "DeviceRGB"), vec![255, 0, 0]);
    assert!(
        r.warnings.degrades_accuracy(),
        "RGB không ICC phải hạ accuracy"
    );
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
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 0 0 0 0 0 0 cm /Im0 Do Q".to_vec(),
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
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
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
    assert_eq!(
        px(&r, 1, 0, h / 2),
        255,
        "pixel chỉ số 1 phải là Magenta 100%"
    );
    assert_eq!(px(&r, 0, 0, h / 2), 0, "và không có Cyan");
    assert_eq!(
        px(&r, 0, w - 1, h / 2),
        255,
        "pixel chỉ số 15 phải là Cyan 100%"
    );
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

fn replace_page_resources(doc: &mut Document, resources: Dictionary) {
    let resources_id = doc.add_object(resources);
    let page_id = *doc
        .get_pages()
        .values()
        .next()
        .expect("fixture phải có một trang");
    doc.get_object_mut(page_id)
        .and_then(Object::as_dict_mut)
        .expect("trang fixture phải là dictionary")
        .set("Resources", Object::Reference(resources_id));
}

const EXPLICIT_MASK_REASON: &str = "ảnh /Mask explicit không giải mã được";
const COLOR_KEY_MASK_REASON: &str = "ảnh /Mask color-key chưa hỗ trợ";

fn render_mask_document_with_options(doc: &Document, options: RenderOptions) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, options).expect("fixture mask phải render được")
}

fn render_mask_document(doc: &Document) -> PageRender {
    render_mask_document_with_options(doc, RenderOptions::ink_accurate())
}

fn pattern_stencil_document(sample: u8, setup: &str) -> Document {
    pattern_stencil_document_with_mask(sample, setup, None)
}

fn pattern_stencil_document_with_mask(
    sample: u8,
    setup: &str,
    explicit_mask: Option<Object>,
) -> Document {
    let content = format!("{setup} /Pattern cs /P0 scn q 10 0 0 10 0 0 cm /Im0 Do Q");
    let mut doc = build(&content, dictionary! {});
    let pattern_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 2.into(), 1.into()],
            "XStep" => 2,
            "YStep" => 1,
            "Resources" => Dictionary::new(),
        },
        // Một cột đen, một cột trắng: bắt được cả lỗi tô màu đặc lẫn lỗi dùng
        // image CTM làm pattern matrix.
        b"0 0 0 1 k 0 0 1 1 re f".to_vec(),
    ));
    let mut stencil = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 1,
    };
    stencil.set("ImageMask", Object::Boolean(true));
    if let Some(explicit_mask) = explicit_mask {
        stencil.set("Mask", explicit_mask);
    }
    let image_id = doc.add_object(Stream::new(stencil, vec![sample]));
    replace_page_resources(
        &mut doc,
        dictionary! {
            "Pattern" => dictionary! { "P0" => Object::Reference(pattern_id) },
            "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "ca" => Object::Real(0.0) },
                "GS1" => dictionary! { "ca" => Object::Real(0.5) },
            },
        },
    );
    doc
}

fn explicit_mask_document(content: &str, image_smask_sample: Option<u8>) -> Document {
    explicit_mask_document_with_sizes(content, image_smask_sample, 2, 2, vec![0b0100_0000])
}

fn explicit_mask_document_with_sizes(
    content: &str,
    image_smask_sample: Option<u8>,
    image_width: i64,
    mask_width: i64,
    mask_data: Vec<u8>,
) -> Document {
    let mut doc = build(content, dictionary! {});
    let mut mask = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => mask_width,
        "Height" => 1,
        "BitsPerComponent" => 1,
    };
    mask.set("ImageMask", Object::Boolean(true));
    // Default /Decode: 0 = opaque, 1 = transparent.
    let mask_id = doc.add_object(Stream::new(mask, mask_data));
    let mut image = base_image(image_width, 1, 8, "DeviceGray");
    image.set("Mask", Object::Reference(mask_id));
    if let Some(sample) = image_smask_sample {
        let smask_id = doc.add_object(Stream::new(
            base_image(image_width, 1, 8, "DeviceGray"),
            vec![sample; image_width as usize],
        ));
        image.set("SMask", Object::Reference(smask_id));
    }
    let image_id = doc.add_object(Stream::new(image, vec![0; image_width as usize]));
    replace_page_resources(
        &mut doc,
        dictionary! {
            "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
            "ExtGState" => dictionary! {
                "GS0" => dictionary! { "ca" => Object::Real(0.0) },
            },
        },
    );
    doc
}

fn malformed_explicit_mask_document(content: &str, mask_obj: Object) -> Document {
    let mut doc = build(content, dictionary! {});
    let mut image = base_image(1, 1, 8, "DeviceGray");
    image.set("Mask", mask_obj);
    let image_id = doc.add_object(Stream::new(image, vec![0]));
    replace_page_resources(
        &mut doc,
        dictionary! { "XObject" => dictionary! { "Im0" => Object::Reference(image_id) } },
    );
    doc
}

fn cyclic_explicit_mask_document(content: &str) -> Document {
    let mut doc = build(content, dictionary! {});
    let image_id = doc.add_object(Object::Null);
    let mask_id = doc.add_object(Object::Null);

    let mut image = base_image(1, 1, 8, "DeviceGray");
    image.set("Mask", Object::Reference(mask_id));
    doc.objects
        .insert(image_id, Object::Stream(Stream::new(image, vec![0])));

    let mut mask = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 1,
        "Mask" => Object::Reference(image_id),
    };
    mask.set("ImageMask", Object::Boolean(true));
    doc.objects
        .insert(mask_id, Object::Stream(Stream::new(mask, vec![0])));

    replace_page_resources(
        &mut doc,
        dictionary! { "XObject" => dictionary! { "Im0" => Object::Reference(image_id) } },
    );
    doc
}

fn cyclic_smask_explicit_mask_document(content: &str) -> Document {
    let mut doc = build(content, dictionary! {});
    let image_id = doc.add_object(Object::Null);
    let smask_id = doc.add_object(Object::Null);

    let mut image = base_image(1, 1, 8, "DeviceGray");
    image.set("SMask", Object::Reference(smask_id));
    doc.objects
        .insert(image_id, Object::Stream(Stream::new(image, vec![0])));

    let mut smask = base_image(1, 1, 8, "DeviceGray");
    smask.set("Mask", Object::Reference(image_id));
    doc.objects
        .insert(smask_id, Object::Stream(Stream::new(smask, vec![255])));

    replace_page_resources(
        &mut doc,
        dictionary! { "XObject" => dictionary! { "Im0" => Object::Reference(image_id) } },
    );
    doc
}

#[test]
fn pattern_painted_image_mask_preserves_spatial_pattern_and_clean_diagnostics() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A02): ImageMask chỉ cung cấp coverage;
    // màu Pattern vẫn là hàm theo stream space, không được quy thành màu đặc.
    let visible_doc = pattern_stencil_document(0, "");
    let visible = render_mask_document(&visible_doc);
    let width = visible.buffer.width() as usize;
    let height = visible.buffer.height() as usize;
    for x in 0..width {
        assert_eq!(
            px(&visible, 3, x, height / 2),
            if x % 2 == 0 { 255 } else { 0 },
            "pattern phải lặp theo stream space tại cột {x}"
        );
    }
    assert_eq!(
        visible
            .buffer
            .plate_u8(3)
            .iter()
            .filter(|value| **value > 0)
            .count(),
        width * height / 2
    );
    assert_eq!(
        visible.warnings.dropped_objects, 0,
        "{:?}",
        visible.warnings
    );
    assert!(!visible.warnings.unsupported_transparency);
    assert!(!visible.warnings.ink_unsound(), "{:?}", visible.warnings);

    let half_alpha_doc = pattern_stencil_document(0, "/GS1 gs");
    let half_alpha = render_mask_document(&half_alpha_doc);
    assert!(
        (px(&half_alpha, 3, 0, height / 2) as i16 - 128).abs() <= 1,
        "fill alpha phải áp đúng một lần"
    );
    assert!(
        !half_alpha.warnings.ink_unsound(),
        "{:?}",
        half_alpha.warnings
    );

    for (control, doc) in [
        (
            "stencil không tô",
            pattern_stencil_document(0b1000_0000, ""),
        ),
        ("clip rỗng", pattern_stencil_document(0, "W n")),
        ("ca bằng 0", pattern_stencil_document(0, "/GS0 gs")),
    ] {
        let rendered = render_mask_document(&doc);
        assert_eq!(rendered.buffer.max_tac_percent(), 0.0, "{control}");
        assert_eq!(rendered.warnings.dropped_objects, 0, "{control}");
        assert!(!rendered.warnings.unsupported_transparency, "{control}");
        assert!(
            !rendered.warnings.ink_unsound(),
            "{control}: {:?}",
            rendered.warnings
        );
    }
}

#[test]
fn output_preview_classifies_pattern_image_mask_as_image_host() {
    let doc = pattern_stencil_document(0, "");
    for filter in [OutputPreviewFilter::Images, OutputPreviewFilter::DeviceCmyk] {
        let shown = render_mask_document_with_options(
            &doc,
            RenderOptions::softproof().with_output_preview_filter(filter),
        );
        assert!(shown.buffer.max_tac_percent() > 90.0, "{filter:?}");
        assert_eq!(shown.warnings.dropped_objects, 0, "{:?}", shown.warnings);
    }
    for filter in [
        OutputPreviewFilter::Text,
        OutputPreviewFilter::LineArt,
        OutputPreviewFilter::DeviceRgb,
    ] {
        let hidden = render_mask_document_with_options(
            &doc,
            RenderOptions::softproof().with_output_preview_filter(filter),
        );
        assert_eq!(hidden.buffer.max_tac_percent(), 0.0, "{filter:?}");
        assert!(!hidden.warnings.ink_unsound(), "{:?}", hidden.warnings);
    }

    let malformed = pattern_stencil_document_with_mask(0, "", Some(Object::Null));
    let source_hidden = render_mask_document_with_options(
        &malformed,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceRgb),
    );
    assert_eq!(source_hidden.buffer.max_tac_percent(), 0.0);
    assert!(
        !source_hidden.warnings.ink_unsound(),
        "Pattern bị source filter ẩn không được nhận warning Mask: {:?}",
        source_hidden.warnings
    );
    let source_visible = render_mask_document_with_options(
        &malformed,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::Images),
    );
    assert!(source_visible.buffer.max_tac_percent() > 90.0);
    assert!(source_visible.warnings.unsupported_transparency);
}

#[test]
fn explicit_image_mask_stream_applies_binary_coverage_with_clean_diagnostics() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A05): explicit `/Mask` dùng polarity
    // ImageMask và được resample vào alpha của ảnh cha.
    let visible_doc = explicit_mask_document("q 10 0 0 10 0 0 cm /Im0 Do Q", None);
    let visible = render_mask_document(&visible_doc);
    let width = visible.buffer.width() as usize;
    let height = visible.buffer.height() as usize;
    assert_eq!(px(&visible, 3, 0, height / 2), 255);
    assert_eq!(px(&visible, 3, width - 1, height / 2), 0);
    assert_eq!(
        visible
            .buffer
            .plate_u8(3)
            .iter()
            .filter(|value| **value > 0)
            .count(),
        width * height / 2
    );
    assert!(
        !visible.warnings.unsupported_transparency,
        "{:?}",
        visible.warnings
    );
    assert_eq!(visible.warnings.dropped_objects, 0);
    assert!(!visible.warnings.ink_unsound(), "{:?}", visible.warnings);

    for (control, doc) in [
        (
            "ngoài viewport",
            explicit_mask_document("q 10 0 0 10 20 0 cm /Im0 Do Q", None),
        ),
        (
            "clip rỗng",
            explicit_mask_document("q W n 10 0 0 10 0 0 cm /Im0 Do Q", None),
        ),
        (
            "ca bằng 0",
            explicit_mask_document("/GS0 gs q 10 0 0 10 0 0 cm /Im0 Do Q", None),
        ),
        (
            "SMask ảnh bằng 0",
            explicit_mask_document("q 10 0 0 10 0 0 cm /Im0 Do Q", Some(0)),
        ),
    ] {
        let rendered = render_mask_document(&doc);
        assert_eq!(rendered.buffer.max_tac_percent(), 0.0, "{control}");
        assert!(!rendered.warnings.unsupported_transparency, "{control}");
        assert_eq!(rendered.warnings.dropped_objects, 0, "{control}");
        assert!(
            !rendered.warnings.ink_unsound(),
            "{control}: {:?}",
            rendered.warnings
        );
    }
}

#[test]
fn explicit_mask_resamples_from_texel_centres_when_dimensions_differ() {
    // Mask 2 texel [opaque, transparent] trên ảnh cha 4 texel phải chia đúng
    // 2+2; nội suy endpoint cũ cho sai 3+1.
    let doc = explicit_mask_document_with_sizes(
        "q 10 0 0 10 0 0 cm /Im0 Do Q",
        None,
        4,
        2,
        vec![0b0100_0000],
    );
    let rendered = render_mask_document(&doc);
    let height = rendered.buffer.height() as usize;
    assert_eq!(px(&rendered, 3, 4, height / 2), 255);
    assert_eq!(px(&rendered, 3, 5, height / 2), 0);
    assert!(!rendered.warnings.ink_unsound(), "{:?}", rendered.warnings);
}

#[test]
fn explicit_image_mask_is_reapplied_for_each_cached_invocation() {
    // Cache chỉ giữ mẫu nguồn; mỗi Do phải áp lại mask theo CTM placement riêng.
    let doc = explicit_mask_document(
        "q 5 0 0 10 0 0 cm /Im0 Do Q \
         q 5 0 0 10 5 0 cm /Im0 Do Q \
         q W n 10 0 0 10 0 0 cm /Im0 Do Q",
        None,
    );
    let rendered = render_mask_document(&doc);
    let height = rendered.buffer.height() as usize;
    assert_eq!(px(&rendered, 3, 0, height / 2), 255);
    assert_eq!(px(&rendered, 3, 4, height / 2), 0);
    assert_eq!(px(&rendered, 3, 5, height / 2), 255);
    assert_eq!(px(&rendered, 3, 9, height / 2), 0);
    assert!(
        !rendered.warnings.unsupported_transparency,
        "{:?}",
        rendered.warnings
    );
    assert!(!rendered.warnings.ink_unsound(), "{:?}", rendered.warnings);
}

#[test]
fn smask_takes_precedence_over_explicit_mask_without_double_multiplication() {
    let doc = explicit_mask_document("q 10 0 0 10 0 0 cm /Im0 Do Q", Some(128));
    let rendered = render_mask_document(&doc);
    let width = rendered.buffer.width() as usize;
    let height = rendered.buffer.height() as usize;
    for x in [0, width - 1] {
        assert!(
            (px(&rendered, 3, x, height / 2) as i16 - 128).abs() <= 1,
            "SMask phải thắng /Mask tại cột {x}"
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
fn null_and_dangling_explicit_masks_are_not_collapsed_to_absent() {
    for (label, mask_obj) in [
        ("null", Object::Null),
        ("dangling", Object::Reference((99_999, 0))),
    ] {
        let visible_doc =
            malformed_explicit_mask_document("q 10 0 0 10 0 0 cm /Im0 Do Q", mask_obj.clone());
        let visible = render_mask_document(&visible_doc);
        assert!(visible.buffer.max_tac_percent() > 99.0, "{label}");
        assert!(visible.warnings.unsupported_transparency, "{label}");
        assert!(visible.warnings.ink_unsound(), "{label}");
        assert!(
            visible
                .warnings
                .skipped_ops
                .iter()
                .any(|(reason, count)| reason == EXPLICIT_MASK_REASON && *count == 1),
            "{label}: {:?}",
            visible.warnings.skipped_ops
        );

        let clipped_doc =
            malformed_explicit_mask_document("q W n 10 0 0 10 0 0 cm /Im0 Do Q", mask_obj);
        let clipped = render_mask_document(&clipped_doc);
        assert!(
            !clipped.warnings.ink_unsound(),
            "{label}: {:?}",
            clipped.warnings
        );
    }
}

#[test]
fn cyclic_explicit_mask_fails_loud_only_for_visible_invocation() {
    // Guard phải chặn vòng parent -> Mask -> parent nhưng diagnostic vẫn defer
    // tới placement thật sự phủ, không làm clip rỗng thành false-positive.
    let visible_doc = cyclic_explicit_mask_document(
        "q 10 0 0 10 0 0 cm /Im0 Do Q q W n 10 0 0 10 0 0 cm /Im0 Do Q",
    );
    let visible = render_mask_document(&visible_doc);
    assert!(visible.buffer.max_tac_percent() > 99.0);
    assert!(visible.warnings.unsupported_transparency);
    assert!(visible.warnings.ink_unsound());
    assert!(
        visible
            .warnings
            .skipped_ops
            .iter()
            .any(|(reason, count)| reason == EXPLICIT_MASK_REASON && *count == 1),
        "{:?}",
        visible.warnings.skipped_ops
    );

    let clipped_doc = cyclic_explicit_mask_document("q W n 10 0 0 10 0 0 cm /Im0 Do Q");
    let clipped = render_mask_document(&clipped_doc);
    assert_eq!(clipped.buffer.max_tac_percent(), 0.0);
    assert!(
        !clipped.warnings.unsupported_transparency,
        "{:?}",
        clipped.warnings
    );
    assert!(!clipped.warnings.ink_unsound(), "{:?}", clipped.warnings);
}

#[test]
fn explicit_mask_failure_nested_in_smask_is_deferred_to_parent_visibility() {
    let visible_doc = cyclic_smask_explicit_mask_document("q 10 0 0 10 0 0 cm /Im0 Do Q");
    let visible = render_mask_document(&visible_doc);
    assert!(visible.buffer.max_tac_percent() > 99.0);
    assert!(visible.warnings.unsupported_transparency);
    assert!(visible.warnings.ink_unsound());
    assert!(
        visible
            .warnings
            .skipped_ops
            .iter()
            .any(|(reason, count)| reason == EXPLICIT_MASK_REASON && *count == 1),
        "{:?}",
        visible.warnings.skipped_ops
    );

    let clipped_doc = cyclic_smask_explicit_mask_document("q W n 10 0 0 10 0 0 cm /Im0 Do Q");
    let clipped = render_mask_document(&clipped_doc);
    assert_eq!(clipped.buffer.max_tac_percent(), 0.0);
    assert!(!clipped.warnings.ink_unsound(), "{:?}", clipped.warnings);
}

#[test]
fn color_key_image_mask_keeps_decode_time_taxonomy() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A05): `/Mask` mảng vẫn là color-key
    // decode-time; không được đổi taxonomy sang explicit mask khi defer warning.
    let mut image = base_image(1, 1, 8, "DeviceGray");
    image.set(
        "Mask",
        Object::Array(vec![Object::Integer(0), Object::Integer(0)]),
    );
    let rendered = render_image(image, vec![0]);
    assert!(rendered.warnings.unsupported_transparency);
    assert!(rendered.warnings.ink_unsound());
    assert_eq!(rendered.warnings.dropped_objects, 0);
    assert!(
        rendered
            .warnings
            .skipped_ops
            .iter()
            .any(|(reason, count)| reason == COLOR_KEY_MASK_REASON && *count == 1),
        "{:?}",
        rendered.warnings.skipped_ops
    );
    assert!(
        !rendered
            .warnings
            .skipped_ops
            .iter()
            .any(|(reason, _)| reason == EXPLICIT_MASK_REASON),
        "{:?}",
        rendered.warnings.skipped_ops
    );
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
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
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
    // CORRECTNESS (audit 2026-08-10 §L6.3): cả hai codec chưa có decoder phải
    // hạ soundness. Bỏ ảnh rồi trả trang trắng là lỗi capability, không phải
    // một lần render thành công để Viewer gắn nhãn color-verified.
    for codec in ["JPXDecode", "JBIG2Decode"] {
        let mut dict = base_image(1, 1, 8, "DeviceGray");
        dict.set("Filter", codec);
        let r = render_image(dict, vec![0, 0, 0]);
        assert!(r.warnings.dropped_objects > 0, "{codec}: {:?}", r.warnings);
        assert!(r.warnings.degrades_accuracy(), "{codec}: {:?}", r.warnings);
        assert!(
            r.warnings
                .skipped_ops
                .iter()
                .any(|(op, _)| op.contains(codec.trim_end_matches("Decode"))),
            "{codec}: {:?}",
            r.warnings.skipped_ops
        );
    }
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
    assert!(
        r.warnings.dropped_objects > 0,
        "phải từ chối, không được OOM"
    );
}

fn render_absurd_image_in_viewport(cm: &str) -> PageRender {
    let mut doc = Document::with_version("1.7");
    let mut image = base_image(1, 1, 8, "DeviceGray");
    image.set("Width", Object::Integer(1_000_000));
    image.set("Height", Object::Integer(1_000_000));
    let image_id = doc.add_object(Stream::new(image, vec![0]));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("q {cm} cm /Im0 Do Q").into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    render_page_managed_region(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
        None,
        Some(RasterClip {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }),
    )
    .expect("viewport phải render được")
}

#[test]
fn viewport_skips_absurd_image_outside_buffer_before_decode() {
    // PERF (audit 2026-08-08 §RENDER.3): ảnh nằm ở góc dưới-phải; viewport và
    // guard-band chỉ phủ góc trên-trái nên không được chạm vào stream hỏng.
    let result = render_absurd_image_in_viewport("10 0 0 10 80 0");
    assert_eq!(result.warnings.dropped_objects, 0, "{:?}", result.warnings);
    assert!(!result.warnings.ink_unsound(), "{:?}", result.warnings);
}

#[test]
fn viewport_visible_absurd_image_still_fails_loud() {
    // Cùng ảnh hỏng nhưng đặt ở góc trên-trái, giao viewport nên cổng tin cậy
    // vẫn phải nhìn thấy lỗi giải mã như đường full-page.
    let result = render_absurd_image_in_viewport("10 0 0 10 0 90");
    assert!(result.warnings.dropped_objects > 0, "{:?}", result.warnings);
    assert!(result.warnings.ink_unsound(), "{:?}", result.warnings);
}

#[test]
fn content_without_images_still_renders() {
    // Bảo đảm phần dựng test không tự làm hỏng đường vector.
    let doc = build("0 0 0 1 k 0 0 10 10 re f", dictionary! {});
    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert!((r.buffer.max_tac_percent() - 100.0).abs() < 0.5);
}

#[test]
fn repeated_indirect_image_reapplies_each_form_ctm() {
    // PERF (audit 2026-08-09 §PERF.9): cùng một ObjectId được gọi qua hai Form;
    // cache chỉ giữ mẫu nguồn, không được giữ bitmap đã biến đổi theo CTM.
    let mut doc = Document::with_version("1.7");
    let image_id = doc.add_object(Stream::new(base_image(2, 1, 8, "DeviceGray"), vec![0, 255]));
    let form_resources = |doc: &mut Document| {
        Object::Reference(doc.add_object(dictionary! {
            "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
        }))
    };
    let form1_resources = form_resources(&mut doc);
    let form1 = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => form1_resources,
        },
        b"10 0 0 10 0 0 cm /Im0 Do".to_vec(),
    ));
    let form2_resources = form_resources(&mut doc);
    let form2 = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 10.into(), 0.into()],
            "Resources" => form2_resources,
        },
        b"10 0 0 10 0 0 cm /Im0 Do".to_vec(),
    ));
    let page_resources = doc.add_object(dictionary! {
        "XObject" => dictionary! {
            "F1" => Object::Reference(form1),
            "F2" => Object::Reference(form2),
        }
    });
    let content = doc.add_object(Stream::new(dictionary! {}, b"/F1 Do /F2 Do".to_vec()));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content),
        "Resources" => Object::Reference(page_resources),
        "MediaBox" => vec![0.into(), 0.into(), 20.into(), 10.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    let rendered = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("form ảnh lặp phải render được");
    let y = rendered.buffer.height() as usize / 2;
    assert_eq!(px(&rendered, 3, 2, y), 255);
    assert_eq!(px(&rendered, 3, 7, y), 0);
    assert_eq!(px(&rendered, 3, 12, y), 255);
    assert_eq!(px(&rendered, 3, 17, y), 0);
}

#[test]
fn named_colorspace_image_is_not_cached_across_form_resource_scopes() {
    // Một ObjectId nhưng `/CS0` trỏ DeviceGray ở Form trái và DeviceCMYK ở Form
    // phải. Cache sai theo ObjectId sẽ làm nửa phải bị coi nhầm là ảnh Gray.
    let mut doc = Document::with_version("1.7");
    let image_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 1,
            "Height" => 1,
            "BitsPerComponent" => 8,
            "ColorSpace" => "CS0",
        },
        vec![0, 255, 0, 0],
    ));
    let gray_resources = doc.add_object(dictionary! {
        "ColorSpace" => dictionary! { "CS0" => "DeviceGray" },
        "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
    });
    let cmyk_resources = doc.add_object(dictionary! {
        "ColorSpace" => dictionary! { "CS0" => "DeviceCMYK" },
        "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
    });
    let form1 = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => Object::Reference(gray_resources),
        },
        b"10 0 0 10 0 0 cm /Im0 Do".to_vec(),
    ));
    let form2 = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 10.into(), 0.into()],
            "Resources" => Object::Reference(cmyk_resources),
        },
        b"10 0 0 10 0 0 cm /Im0 Do".to_vec(),
    ));
    let page_resources = doc.add_object(dictionary! {
        "XObject" => dictionary! {
            "F1" => Object::Reference(form1),
            "F2" => Object::Reference(form2),
        }
    });
    let content = doc.add_object(Stream::new(dictionary! {}, b"/F1 Do /F2 Do".to_vec()));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content),
        "Resources" => Object::Reference(page_resources),
        "MediaBox" => vec![0.into(), 0.into(), 20.into(), 10.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    let rendered = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("named colorspace fixture phải render được");
    let y = rendered.buffer.height() as usize / 2;
    assert_eq!(px(&rendered, 3, 5, y), 255, "Gray form phải có K");
    assert_eq!(
        px(&rendered, 3, 15, y),
        0,
        "CMYK form không được mượn cache Gray"
    );
}

/// Dựng PDF đặt một ảnh (tuỳ chọn kèm `/SMask`) bằng `cm` tuỳ ý rồi render @72.
fn render_placed_image(
    cm: &str,
    image_dict: Dictionary,
    data: Vec<u8>,
    smask: Option<(Dictionary, Vec<u8>)>,
) -> PageRender {
    let mut doc = Document::with_version("1.7");
    let mut image_dict = image_dict;
    if let Some((sd, sdata)) = smask {
        let sid = doc.add_object(Stream::new(sd, sdata));
        image_dict.set("SMask", Object::Reference(sid));
    }
    let img_id = doc.add_object(Stream::new(image_dict, data));
    let resources = dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    };
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("q {cm} cm /Im0 Do Q").into_bytes(),
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

/// Sọc K tại các texel chia hết cho 4, dữ liệu CMYK thô.
fn stripe_cmyk(n: usize) -> Vec<u8> {
    (0..n)
        .flat_map(|x| {
            if x % 4 == 0 {
                [0u8, 0, 0, 255]
            } else {
                [0u8, 0, 0, 0]
            }
        })
        .collect()
}

#[test]
fn texel_boundary_tie_picks_left_texel_like_gs() {
    // Ảnh 8 texel đặt `4 0 0 4 0 3 cm`: tâm pixel i rơi đúng biên texel
    // (u*8 = 2i+1, nguyên). Quy ước GS là khoảng nửa-mở TRÁI: tie lấy texel
    // 2i (sọc BẬT tại texel chẵn). Quy ước floor lấy texel lẻ → cả hàng tắt —
    // đo black-box GS 10.04: sọc chu kỳ 4 với offset nguyên cho pattern 1-in-5
    // chỉ giải thích được bằng tie-trái.
    let mut samples = Vec::new();
    for x in 0..8 {
        samples.extend_from_slice(if x % 2 == 0 {
            &[0u8, 0, 0, 255]
        } else {
            &[0u8, 0, 0, 0]
        });
    }
    let r = render_placed_image(
        "4 0 0 4 0 3",
        base_image(8, 1, 8, "DeviceCMYK"),
        samples,
        None,
    );
    for x in 0..4 {
        assert_eq!(
            px(&r, 3, x, 5),
            255,
            "tie tại pixel {x} phải lấy texel trái (chẵn, có mực)"
        );
    }
}

#[test]
fn smask_image_samples_on_integer_bbox_grid_like_gs() {
    // Ảnh 30 texel + /SMask, đặt `7.4 0 0 7.4 0.3 1 cm` → footprint x [0.3,7.7],
    // bbox pixel-nguyên [0,8). Đo black-box GS 10.04: ảnh có mask lấy mẫu như
    // thể hình vuông đơn vị phủ bbox đó (căng ~1px). Trên lưới căng:
    // t = (i+0.5)*30/8 → texel 1,5,9,13,16,20,24,28 → sọc (mod 4) BẬT ở pixel
    // 4..7. Lưới chính xác (code cũ) cho 0,4,8,12,17,... → BẬT ở 0..3 — pattern
    // đảo ngược hoàn toàn, không thể pass nhầm.
    let smask = (base_image(30, 1, 8, "DeviceGray"), vec![255u8; 30]);
    let r = render_placed_image(
        "7.4 0 0 7.4 0.3 1",
        base_image(30, 1, 8, "DeviceCMYK"),
        stripe_cmyk(30),
        Some(smask),
    );
    let row = 5;
    for x in 0..4 {
        assert_eq!(px(&r, 3, x, row), 0, "pixel {x} phải TẮT trên lưới bbox");
    }
    for x in 4..8 {
        assert_eq!(px(&r, 3, x, row), 255, "pixel {x} phải BẬT trên lưới bbox");
    }
}

fn replace_tiling_pattern_cell(doc: &mut Document, content: &str, resources: Dictionary) {
    let mut found = false;
    for object in doc.objects.values_mut() {
        let Object::Stream(stream) = object else {
            continue;
        };
        let is_tiling_pattern =
            matches!(
                stream.dict.get(b"Type"),
                Ok(Object::Name(name)) if name.as_slice() == b"Pattern"
            ) && matches!(stream.dict.get(b"PatternType"), Ok(Object::Integer(1)));
        if is_tiling_pattern {
            stream.content = content.as_bytes().to_vec();
            stream.dict.set("Resources", Object::Dictionary(resources));
            found = true;
            break;
        }
    }
    assert!(found, "fixture phải tìm được tiling Pattern");
}

#[test]
fn pattern_image_mask_warning_requires_effective_parent_surface_paint() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A02/A05): sink alpha 0 và paint chỉ
    // dùng để dựng soft mask là surface phụ, không được làm Pattern host vô hình
    // commit diagnostic `/Mask` explicit lên output trang.
    let mut zero_alpha = pattern_stencil_document_with_mask(0, "", Some(Object::Null));
    replace_tiling_pattern_cell(
        &mut zero_alpha,
        "/GSZero gs 0 0 0 1 k 0 0 2 1 re f",
        dictionary! {
            "ExtGState" => dictionary! {
                "GSZero" => dictionary! { "ca" => Object::Real(0.0) },
            },
        },
    );

    let mut smask_only = pattern_stencil_document_with_mask(0, "", Some(Object::Null));
    let mask_form = smask_only.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), 2.into(), 1.into()],
            "Resources" => Dictionary::new(),
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        b"0 g 0 0 2 1 re f".to_vec(),
    ));
    replace_tiling_pattern_cell(
        &mut smask_only,
        "/GSMask gs",
        dictionary! {
            "ExtGState" => dictionary! {
                "GSMask" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => Object::Reference(mask_form),
                    }),
                },
            },
        },
    );

    for (label, doc) in [
        ("cell-local ca bằng 0", zero_alpha),
        ("cell chỉ dựng soft mask", smask_only),
    ] {
        let rendered = render_mask_document(&doc);
        assert_eq!(rendered.buffer.max_tac_percent(), 0.0, "{label}");
        assert!(
            !rendered.warnings.unsupported_transparency,
            "{label}: {:?}",
            rendered.warnings
        );
        assert!(
            !rendered
                .warnings
                .skipped_ops
                .iter()
                .any(|(reason, _)| reason == EXPLICIT_MASK_REASON),
            "{label}: {:?}",
            rendered.warnings.skipped_ops
        );
        assert!(
            !rendered.warnings.ink_unsound(),
            "{label}: {:?}",
            rendered.warnings
        );
    }
}

fn nested_group_pattern_mask_document(group_alpha: f32, external_mask: Option<bool>) -> Document {
    let mut doc = Document::with_version("1.7");
    let pattern = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "XStep" => 1,
            "YStep" => 1,
            "Resources" => Dictionary::new(),
        },
        b"0 0 0 1 k 0 0 1 1 re f".to_vec(),
    ));
    let mut stencil = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 1,
        "Mask" => Object::Null,
    };
    stencil.set("ImageMask", Object::Boolean(true));
    let image = doc.add_object(Stream::new(stencil, vec![0]));
    let group = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => dictionary! {
                "Pattern" => dictionary! { "P0" => Object::Reference(pattern) },
                "XObject" => dictionary! { "Im0" => Object::Reference(image) },
            },
            "Group" => dictionary! {
                "S" => "Transparency",
                "CS" => "DeviceCMYK",
                "I" => Object::Boolean(true),
            },
        },
        b"/Pattern cs /P0 scn q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));

    let mut ext_gstate = dictionary! { "ca" => Object::Real(group_alpha) };
    if let Some(mask_paints) = external_mask {
        let mask_content = if mask_paints {
            b"0 g 0 0 10 10 re f".to_vec()
        } else {
            Vec::new()
        };
        let mask_form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "FormType" => 1,
                "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "Resources" => Dictionary::new(),
                "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
            },
            mask_content,
        ));
        ext_gstate.set(
            "SMask",
            Object::Dictionary(dictionary! {
                "S" => "Alpha",
                "G" => Object::Reference(mask_form),
            }),
        );
    }

    let resources = doc.add_object(dictionary! {
        "XObject" => dictionary! { "F0" => Object::Reference(group) },
        "ExtGState" => dictionary! { "GS0" => Object::Dictionary(ext_gstate) },
    });
    let content = doc.add_object(Stream::new(dictionary! {}, b"/GS0 gs /F0 Do".to_vec()));
    let pages = (doc.new_object_id().0, 0);
    let page = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages),
        "Contents" => Object::Reference(content),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages),
    });
    doc.trailer.set("Root", Object::Reference(catalog));
    doc
}

#[test]
fn nested_group_only_propagates_explicit_mask_warning_after_visible_merge() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A05): image malformed nằm trong child
    // surface chỉ được fail-loud khi alpha/SMask của chính group cho phép merge.
    for (label, doc) in [
        (
            "group ca bằng 0",
            nested_group_pattern_mask_document(0.0, None),
        ),
        (
            "group có SMask alpha bằng 0",
            nested_group_pattern_mask_document(1.0, Some(false)),
        ),
    ] {
        let rendered = render_mask_document(&doc);
        assert_eq!(rendered.buffer.max_tac_percent(), 0.0, "{label}");
        assert!(
            !rendered.warnings.ink_unsound(),
            "{label}: {:?}",
            rendered.warnings
        );
        assert!(
            !rendered
                .warnings
                .skipped_ops
                .iter()
                .any(|(reason, _)| reason == EXPLICIT_MASK_REASON),
            "{label}: {:?}",
            rendered.warnings.skipped_ops
        );
    }

    for (label, doc) in [
        (
            "group alpha dương",
            nested_group_pattern_mask_document(1.0, None),
        ),
        (
            "group có SMask alpha dương",
            nested_group_pattern_mask_document(1.0, Some(true)),
        ),
    ] {
        let rendered = render_mask_document(&doc);
        assert!(rendered.buffer.max_tac_percent() > 99.0, "{label}");
        assert!(rendered.warnings.ink_unsound(), "{label}");
        assert!(rendered.warnings.unsupported_transparency, "{label}");
        assert!(
            rendered
                .warnings
                .skipped_ops
                .iter()
                .any(|(reason, count)| reason == EXPLICIT_MASK_REASON && *count == 1),
            "{label}: {:?}",
            rendered.warnings.skipped_ops
        );
    }
}

fn soft_mask_with_malformed_pattern_image_document(paint_after_gs: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let pattern = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "XStep" => 1,
            "YStep" => 1,
            "Resources" => Dictionary::new(),
        },
        b"0 g 0 0 1 1 re f".to_vec(),
    ));
    let mut stencil = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 1,
        "Mask" => Object::Null,
    };
    stencil.set("ImageMask", Object::Boolean(true));
    let image = doc.add_object(Stream::new(stencil, vec![0]));
    let mask_form = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => dictionary! {
                "Pattern" => dictionary! { "P0" => Object::Reference(pattern) },
                "XObject" => dictionary! { "Im0" => Object::Reference(image) },
            },
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        b"/Pattern cs /P0 scn q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let resources = doc.add_object(dictionary! {
        "ExtGState" => dictionary! {
            "GS0" => dictionary! {
                "SMask" => Object::Dictionary(dictionary! {
                    "S" => "Alpha",
                    "G" => Object::Reference(mask_form),
                }),
            },
        },
    });
    let content = if paint_after_gs {
        "/GS0 gs 0 0 0 1 k 0 0 10 10 re f"
    } else {
        "/GS0 gs"
    };
    let content = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let pages = (doc.new_object_id().0, 0);
    let page = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages),
        "Contents" => Object::Reference(content),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages),
    });
    doc.trailer.set("Root", Object::Reference(catalog));
    doc
}

#[test]
fn soft_mask_child_warning_waits_until_the_mask_is_used_for_visible_paint() {
    let unused = render_mask_document(&soft_mask_with_malformed_pattern_image_document(false));
    assert_eq!(unused.buffer.max_tac_percent(), 0.0);
    assert!(!unused.warnings.ink_unsound(), "{:?}", unused.warnings);

    let used = render_mask_document(&soft_mask_with_malformed_pattern_image_document(true));
    assert!(used.buffer.max_tac_percent() > 99.0);
    assert!(used.warnings.ink_unsound());
    assert!(
        used.warnings
            .skipped_ops
            .iter()
            .any(|(reason, count)| reason == EXPLICIT_MASK_REASON && *count == 1),
        "{:?}",
        used.warnings.skipped_ops
    );
}

fn finish_spatial_mask_document(
    mut doc: Document,
    content: &str,
    resources: Dictionary,
    page_width: i64,
) -> Document {
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let resources_id = doc.add_object(resources);
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), page_width.into(), 10.into()],
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

fn partial_group_external_smask_document(mask_opens_left: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let mut malformed = base_image(1, 1, 8, "DeviceGray");
    malformed.set("Mask", Object::Null);
    let malformed_id = doc.add_object(Stream::new(malformed, vec![0]));
    let group_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Bad" => Object::Reference(malformed_id) },
            },
            "Group" => dictionary! {
                "S" => "Transparency",
                "CS" => "DeviceCMYK",
                "I" => Object::Boolean(true),
            },
        },
        // Malformed image ở trái; object hợp lệ ở phải, cách nhau một dải trắng.
        b"q 3 0 0 10 0 0 cm /Bad Do Q 0 0 0 1 k 7 0 3 10 re f".to_vec(),
    ));
    let mask_content = if mask_opens_left {
        b"0 g 0 0 3 10 re f".to_vec()
    } else {
        b"0 g 7 0 3 10 re f".to_vec()
    };
    let mask_form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => dictionary! {},
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        mask_content,
    ));
    finish_spatial_mask_document(
        doc,
        "/GS0 gs /F0 Do",
        dictionary! {
            "XObject" => dictionary! { "F0" => Object::Reference(group_id) },
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => Object::Reference(mask_form_id),
                    }),
                },
            },
        },
        10,
    )
}

fn offset_soft_mask_reuse_document(paint_event_region: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let mut malformed = base_image(1, 1, 8, "DeviceGray");
    malformed.set("Mask", Object::Null);
    let malformed_id = doc.add_object(Stream::new(malformed, vec![0]));
    let mask_form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            // BBox lệch xa gốc để regression bắt buộc dịch Region local → parent.
            "BBox" => vec![20.into(), 0.into(), 40.into(), 10.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Bad" => Object::Reference(malformed_id) },
            },
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        // Event malformed ở [20,25); alpha hợp lệ độc lập ở [35,40).
        b"q 5 0 0 10 20 0 cm /Bad Do Q 0 g 35 0 5 10 re f".to_vec(),
    ));
    let content = if paint_event_region {
        concat!("/GS0 gs 0 0 0 1 k ", "35 0 5 10 re f ", "20 0 5 10 re f")
    } else {
        "/GS0 gs 0 0 0 1 k 35 0 5 10 re f"
    };
    finish_spatial_mask_document(
        doc,
        content,
        dictionary! {
            "ExtGState" => dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => Object::Reference(mask_form_id),
                    }),
                },
            },
        },
        50,
    )
}

fn explicit_mask_warning_count(rendered: &PageRender) -> u32 {
    rendered
        .warnings
        .skipped_ops
        .iter()
        .find(|(reason, _)| reason == EXPLICIT_MASK_REASON)
        .map_or(0, |(_, count)| *count)
}

#[test]
fn partial_group_smask_only_promotes_spatially_overlapping_child_event() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A05): object hợp lệ ở nửa phải không
    // được kéo event malformed ở nửa trái qua external SMask chỉ mở nửa phải.
    let disjoint = render_mask_document(&partial_group_external_smask_document(false));
    assert!(disjoint.buffer.max_tac_percent() > 99.0);
    assert_eq!(
        explicit_mask_warning_count(&disjoint),
        0,
        "{:?}",
        disjoint.warnings
    );
    assert!(!disjoint.warnings.ink_unsound(), "{:?}", disjoint.warnings);

    let overlapping = render_mask_document(&partial_group_external_smask_document(true));
    assert!(overlapping.buffer.max_tac_percent() > 99.0);
    assert_eq!(
        explicit_mask_warning_count(&overlapping),
        1,
        "event giao vùng mask phải fail-loud đúng một lần: {:?}",
        overlapping.warnings
    );
    assert!(overlapping.warnings.ink_unsound());
}

#[test]
fn soft_mask_event_waits_for_spatially_overlapping_reuse() {
    // Lần dùng đầu chỉ paint vùng alpha hợp lệ ở phải. Metadata event phải còn
    // sống nhưng chưa promote; lần dùng thứ hai giao vùng malformed mới cảnh báo.
    let disjoint = render_page(
        &offset_soft_mask_reuse_document(false),
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
    )
    .expect("SMask lệch gốc phải render được");
    assert!(disjoint.buffer.max_tac_percent() > 99.0);
    assert_eq!(
        explicit_mask_warning_count(&disjoint),
        0,
        "{:?}",
        disjoint.warnings
    );
    assert!(!disjoint.warnings.ink_unsound(), "{:?}", disjoint.warnings);

    let reused = render_page(
        &offset_soft_mask_reuse_document(true),
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
    )
    .expect("SMask tái sử dụng phải render được");
    assert_eq!(
        explicit_mask_warning_count(&reused),
        1,
        "Region local phải được dịch và event tái sử dụng chỉ đếm một lần: {:?}",
        reused.warnings
    );
    assert!(reused.warnings.ink_unsound());
}
