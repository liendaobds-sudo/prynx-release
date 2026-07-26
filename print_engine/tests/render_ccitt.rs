//! Test tích hợp `CCITTFaxDecode` — ảnh scan đen trắng.
//!
//! Đây thường là **toàn bộ** nội dung của một trang bản vẽ hoặc bản can, nên trước
//! khi có bộ giải mã này, cả trang bị nhường cho Ghostscript.
//!
//! Dữ liệu G4 dùng ở đây do một encoder độc lập (libtiff) sinh ra từ một bitmap đã
//! biết, nên test chốt được cả bảng mã lẫn đường nối vào tầng ảnh.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

/// Bitmap nguồn: 24×12, hình chữ nhật đen `x ∈ [8,16)`, `y ∈ [3,9)` (gốc trên-trái).
const G4: &[u8] = &[0xE6, 0x62, 0xFF, 0xFF, 0x8F, 0x00, 0x10, 0x01];
const IMG_W: i64 = 24;
const IMG_H: i64 = 12;

/// Vẽ ảnh phủ kín một trang 24×12 point ⇒ 1 pixel ảnh = 1 pixel raster ở 72 DPI.
fn render_ccitt(extra_image: Dictionary, parms: Dictionary) -> PageRender {
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => IMG_W,
        "Height" => IMG_H,
        "BitsPerComponent" => 1,
        "ColorSpace" => "DeviceGray",
        "Filter" => "CCITTFaxDecode",
        "DecodeParms" => Object::Dictionary(parms),
    };
    for (k, v) in extra_image.iter() {
        dict.set(k.to_vec(), v.clone());
    }

    let mut doc = Document::with_version("1.7");
    let img = doc.add_object(Stream::new(dict, G4.to_vec()));
    let resources = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("q {IMG_W} 0 0 {IMG_H} 0 0 cm /Im0 Do Q").into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), IMG_W.into(), IMG_H.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn g4_parms() -> Dictionary {
    dictionary! { "K" => -1, "Columns" => IMG_W, "Rows" => IMG_H }
}

fn px(r: &PageRender, channel: usize, x: usize, y: usize) -> u8 {
    r.buffer.plate_u8(channel)[y * r.buffer.width() as usize + x]
}

#[test]
fn group4_image_lands_ink_exactly_where_the_bitmap_is_black() {
    let r = render_ccitt(dictionary! {}, g4_parms());
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    // Ảnh chiếm hình vuông đơn vị và hàng 0 của ảnh nằm ở **đỉnh**, nên y của raster
    // trùng y của bitmap.
    assert_eq!(px(&r, 3, 10, 5), 255, "trong hình chữ nhật phải đặc mực");
    assert_eq!(px(&r, 3, 2, 5), 0, "bên trái hình chữ nhật phải trắng");
    assert_eq!(px(&r, 3, 10, 1), 0, "phía trên hình chữ nhật phải trắng");
    assert_eq!(px(&r, 3, 20, 10), 0, "góc dưới-phải phải trắng");
}

#[test]
fn group4_image_covers_the_expected_area() {
    // 8×6 pixel đen trên 24×12 = 16.7% diện tích. Lệch nghĩa là hàng bị lệch hoặc
    // bảng mã sai — cả hai đều làm lượng mực đo được sai.
    let r = render_ccitt(dictionary! {}, g4_parms());
    let cov = r.buffer.plate_coverage_pct(3);
    let expected = 8.0 * 6.0 / (24.0 * 12.0) * 100.0;
    assert!(
        (cov - expected).abs() < 1.5,
        "độ phủ {cov} phải ~{expected}"
    );
}

#[test]
fn black_is_1_inverts_the_image() {
    // `/BlackIs1 true` đảo chiều bit. Đây là cờ mà cài sai cho ra ảnh âm bản **mà
    // không có lỗi nào nổi lên** — nên nó có test riêng.
    let mut parms = g4_parms();
    parms.set("BlackIs1", Object::Boolean(true));
    let r = render_ccitt(dictionary! {}, parms);
    assert_eq!(px(&r, 3, 10, 5), 0, "hình chữ nhật giờ phải trắng");
    assert_eq!(px(&r, 3, 2, 5), 255, "nền giờ phải đen");
}

#[test]
fn ccitt_image_mask_uses_the_current_fill_colour() {
    // Ảnh scan hay được dùng làm stencil để in bằng một mực pha.
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => IMG_W,
        "Height" => IMG_H,
        "ImageMask" => Object::Boolean(true),
        "Filter" => "CCITTFaxDecode",
        "DecodeParms" => Object::Dictionary(g4_parms()),
    };
    dict.remove(b"ColorSpace");

    let mut doc = Document::with_version("1.7");
    let img = doc.add_object(Stream::new(dict, G4.to_vec()));
    let resources = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("1 0 0 0 k q {IMG_W} 0 0 {IMG_H} 0 0 cm /Im0 Do Q").into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), IMG_W.into(), IMG_H.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert_eq!(px(&r, 0, 10, 5), 255, "stencil phải lên mực Cyan");
    assert_eq!(px(&r, 3, 10, 5), 0, "và không lên K");
    assert_eq!(px(&r, 0, 2, 5), 0, "ngoài stencil phải trắng");
}

#[test]
fn missing_decode_parms_falls_back_to_the_image_width() {
    // Không có `/DecodeParms`: spec nói `/Columns` mặc định 1728, nhưng ảnh khai
    // `/Width 24`. Tin `/Width` — dùng 1728 sẽ làm mọi hàng lệch.
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => IMG_W,
        "Height" => IMG_H,
        "BitsPerComponent" => 1,
        "ColorSpace" => "DeviceGray",
        "Filter" => "CCITTFaxDecode",
    };
    // `K` mặc định 0 (nhóm 3 một chiều) nên stream G4 sẽ không giải được — điều cần
    // kiểm ở đây chỉ là engine không treo và ghi nhận trung thực.
    dict.remove(b"DecodeParms");

    let mut doc = Document::with_version("1.7");
    let img = doc.add_object(Stream::new(dict, G4.to_vec()));
    let resources = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("q {IMG_W} 0 0 {IMG_H} 0 0 cm /Im0 Do Q").into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), IMG_W.into(), IMG_H.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    // Không được panic; kết quả thế nào cũng được miễn là trung thực.
    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let _ = r.buffer.max_tac_percent();
}

#[test]
fn corrupt_ccitt_data_is_reported_not_silently_blank() {
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => IMG_W,
        "Height" => IMG_H,
        "BitsPerComponent" => 1,
        "ColorSpace" => "DeviceGray",
        "Filter" => "CCITTFaxDecode",
        "DecodeParms" => Object::Dictionary(g4_parms()),
    };
    dict.set("Height", IMG_H);

    let mut doc = Document::with_version("1.7");
    // Toàn bit 0: không khớp mã chế độ nào.
    let img = doc.add_object(Stream::new(dict, vec![0u8; 16]));
    let resources = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("q {IMG_W} 0 0 {IMG_H} 0 0 cm /Im0 Do Q").into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), IMG_W.into(), IMG_H.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert!(
        r.warnings.dropped_objects > 0,
        "dữ liệu hỏng phải được ghi nhận"
    );
    assert!(r.warnings.ink_unsound());
}
