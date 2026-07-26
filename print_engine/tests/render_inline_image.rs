//! Test tích hợp ảnh nội tuyến (`BI … ID … EI`) — đường end-to-end.
//!
//! Test đơn vị trong `content::inline_image` đã kiểm việc **bóc** khối. Ở đây kiểm
//! thứ quan trọng hơn: mực có thực sự lên kẽm, và phần content **sau** khối ảnh có
//! còn được thực thi hay không.
//!
//! Điểm thứ hai là lý do module này tồn tại. Nếu bộ tokenize đọc dữ liệu nhị phân
//! thành operator, nó không báo lỗi — nó bỏ nốt phần còn lại của trang. Trang ra
//! **trống một nửa** mà engine vẫn báo thành công, và báo cáo TAC nói trang sạch.

use lopdf::{dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 4;

/// Dựng PDF một trang với content **dạng byte** (ảnh nội tuyến có dữ liệu nhị phân).
fn render_bytes(content: Vec<u8>) -> PageRender {
    let mut doc = Document::with_version("1.7");
    let content_id = doc.add_object(Stream::new(dictionary! {}, content));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => dictionary! {},
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
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

/// Khối ảnh nội tuyến phủ kín trang.
fn inline_full_page(dict: &str, data: &[u8]) -> Vec<u8> {
    let mut out = format!("q {PAGE} 0 0 {PAGE} 0 0 cm BI {dict} ID ").into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b" EI Q\n");
    out
}

fn px(r: &PageRender, channel: usize, x: usize, y: usize) -> u8 {
    r.buffer.plate_u8(channel)[y * r.buffer.width() as usize + x]
}

#[test]
fn uncompressed_gray_inline_image_paints_black_ink() {
    let content = inline_full_page("/W 1 /H 1 /BPC 8 /CS /G", &[0x00]);
    let r = render_bytes(content);
    assert_eq!(px(&r, 3, 2, 2), 255, "xám 0 phải là K 100%");
    assert_eq!(px(&r, 0, 2, 2), 0, "không được sinh Cyan");
    assert_eq!(r.warnings.dropped_objects, 0);
}

#[test]
fn cmyk_inline_image_reaches_400_percent_tac() {
    // Ảnh nội tuyến phải đi cùng đường quy đổi màu với ảnh XObject: mực là mực,
    // không qua ICC, nên vùng đặc đọc đúng 400%.
    let content = inline_full_page("/W 1 /H 1 /BPC 8 /CS /CMYK", &[0xFF, 0xFF, 0xFF, 0xFF]);
    let r = render_bytes(content);
    assert!((r.buffer.max_tac_percent() - 400.0).abs() < 0.5);
}

#[test]
fn content_after_an_inline_image_is_still_executed() {
    // Đây là bài test chống lỗi im lặng tệ nhất của ảnh nội tuyến.
    let mut content = inline_full_page("/W 1 /H 1 /BPC 8 /CS /G", &[0xFF]); // trắng
    content.extend_from_slice(format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f").as_bytes());
    let r = render_bytes(content);
    assert_eq!(
        px(&r, 3, 2, 2),
        255,
        "hình vẽ SAU khối ảnh phải được thực thi"
    );
}

#[test]
fn binary_data_containing_ei_does_not_truncate_the_stream() {
    // Dữ liệu 8 byte có chứa đúng " EI " ở giữa. Nếu dò `EI` bằng heuristic thì khối
    // bị cắt sớm và phần sau bị đọc thành rác; đường tính-trước độ dài phải thắng.
    let mut content = format!("q {PAGE} 0 0 {PAGE} 0 0 cm BI /W 8 /H 1 /BPC 8 /CS /G ID ")
        .into_bytes();
    content.extend_from_slice(&[0x00, 0x20, b'E', b'I', 0x20, 0x00, 0x00, 0x00]);
    content.extend_from_slice(b" EI Q\n");
    content.extend_from_slice(format!("1 0 0 0 k 0 0 {PAGE} 1 re f").as_bytes());
    let r = render_bytes(content);
    assert_eq!(r.warnings.dropped_objects, 0, "{:?}", r.warnings.skipped_ops);
    // Hình Cyan sau khối ảnh vẫn phải được vẽ ⇒ stream không bị cắt.
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 0, 2, h - 1), 255, "Cyan sau ảnh phải có");
}

#[test]
fn flate_compressed_inline_image_is_decoded() {
    let raw = [0x00u8]; // xám 0 ⇒ K 100%
    let mut enc = Vec::new();
    {
        use std::io::Write;
        let mut z = flate2::write::ZlibEncoder::new(&mut enc, flate2::Compression::default());
        z.write_all(&raw).unwrap();
        z.finish().unwrap();
    }
    let content = inline_full_page("/W 1 /H 1 /BPC 8 /CS /G /F /Fl /L 0", &enc);
    // `/L 0` là sai có chủ ý ⇒ engine phải lùi về dò `EI` và vẫn giải mã được.
    let r = render_bytes(content);
    assert_eq!(px(&r, 3, 2, 2), 255, "{:?}", r.warnings.skipped_ops);
}

#[test]
fn asciihex_compressed_inline_image_is_decoded() {
    let content = inline_full_page("/W 1 /H 1 /BPC 8 /CS /G /F /AHx", b"00>");
    let r = render_bytes(content);
    assert_eq!(px(&r, 3, 2, 2), 255);
}

#[test]
fn inline_image_mask_uses_the_current_fill_colour() {
    // Stencil lấy màu từ trạng thái tô, không từ ảnh. 1 bit, `/Decode [1 0]` để bit 0
    // là "vẽ".
    let mut content = format!("1 0 0 0 k q {PAGE} 0 0 {PAGE} 0 0 cm BI /W 1 /H 1 /IM true ID ")
        .into_bytes();
    content.extend_from_slice(&[0x00]);
    content.extend_from_slice(b" EI Q\n");
    let r = render_bytes(content);
    assert_eq!(px(&r, 0, 2, 2), 255, "stencil phải lên mực Cyan");
    assert_eq!(px(&r, 3, 2, 2), 0, "và không lên K");
}

#[test]
fn decode_array_inverts_inline_image_samples() {
    // `/D [1 0]` đảo thang ⇒ xám 255 thành K 100%.
    let content = inline_full_page("/W 1 /H 1 /BPC 8 /CS /G /D [1 0]", &[0xFF]);
    let r = render_bytes(content);
    assert_eq!(px(&r, 3, 2, 2), 255);
}

#[test]
fn two_inline_images_land_in_their_own_places() {
    let half = PAGE / 2;
    let mut content = format!("q {half} 0 0 {PAGE} 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /G ID ")
        .into_bytes();
    content.extend_from_slice(&[0x00]); // đen, nửa trái
    content.extend_from_slice(b" EI Q\n");
    content.extend_from_slice(
        format!("q {half} 0 0 {PAGE} {half} 0 cm BI /W 1 /H 1 /BPC 8 /CS /G ID ").as_bytes(),
    );
    content.extend_from_slice(&[0xFF]); // trắng, nửa phải
    content.extend_from_slice(b" EI Q\n");
    let r = render_bytes(content);
    let w = r.buffer.width() as usize;
    assert_eq!(px(&r, 3, 0, 2), 255, "nửa trái phải đen");
    assert_eq!(px(&r, 3, w - 1, 2), 0, "nửa phải phải trắng");
}

#[test]
fn malformed_inline_image_is_reported_not_silently_dropped() {
    // Dict có token lạ ⇒ không dựng được ảnh. Phải đếm là mất nội dung.
    let mut content = format!("q {PAGE} 0 0 {PAGE} 0 0 cm BI 42 /W 1 /H 1 ID ").into_bytes();
    content.extend_from_slice(&[0x00]);
    content.extend_from_slice(b" EI Q\n");
    let r = render_bytes(content);
    assert!(r.warnings.dropped_objects > 0, "phải đếm khối hỏng");
    assert!(r.warnings.ink_unsound(), "và hạ tin cậy");
}

#[test]
fn inline_image_inside_a_form_xobject_works() {
    // Form có content stream riêng ⇒ đường bóc ảnh phải chạy cho **mọi** stream,
    // không chỉ stream của trang.
    let mut doc = Document::with_version("1.7");
    let mut form_content = format!("q {PAGE} 0 0 {PAGE} 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /G ID ")
        .into_bytes();
    form_content.extend_from_slice(&[0x00]);
    form_content.extend_from_slice(b" EI Q");
    let form = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        },
        form_content,
    ));
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"/Fm0 Do".to_vec()));
    let resources = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Fm0" => Object::Reference(form) },
    });
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
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
    assert_eq!(r.buffer.plate_u8(3)[2 * r.buffer.width() as usize + 2], 255);
}
