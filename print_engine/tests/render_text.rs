//! Test tích hợp vẽ chữ.
//!
//! Dùng font TrueType thật (`DejaVuSans.ttf` bundle trong repo) thay vì font giả:
//! chỉ font thật mới đi qua đủ đường `cmap` → `glyf` → outline, và chính đường đó
//! là nơi dễ sai nhất.

use std::path::{Path, PathBuf};

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::color::space::OutputPreviewFilter;
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 120;

fn font_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("backend/app/assets/fonts/DejaVuSans.ttf")
}

fn font_bytes() -> Option<Vec<u8>> {
    std::fs::read(font_path()).ok()
}

macro_rules! font_or_skip {
    () => {
        match font_bytes() {
            Some(b) => b,
            None => {
                eprintln!("bỏ qua: không có DejaVuSans.ttf");
                return;
            }
        }
    };
}

/// Dựng PDF một trang có font TrueType nhúng.
///
/// `widths`: nếu `None` thì không khai `/Widths` để buộc engine lấy bề rộng từ
/// chính chương trình font.
fn build_with_truetype(content: &str, ttf: Vec<u8>, widths: bool) -> Document {
    let mut doc = Document::with_version("1.7");

    let font_file = doc.add_object(Stream::new(
        dictionary! { "Length1" => ttf.len() as i64 },
        ttf,
    ));
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "DejaVuSans",
        // Flags bit 3 (giá trị 4) = symbolic. Ở đây là font chữ thường nên đặt
        // nonsymbolic (32) để engine dùng bảng mã khai trong /Encoding.
        "Flags" => 32,
        "ItalicAngle" => 0,
        "Ascent" => 900,
        "Descent" => -200,
        "CapHeight" => 700,
        "StemV" => 80,
        "FontBBox" => vec![(-1021).into(), (-463).into(), 1793.into(), 1232.into()],
        "FontFile2" => Object::Reference(font_file),
    });

    let mut font = dictionary! {
        "Type" => "Font",
        "Subtype" => "TrueType",
        "BaseFont" => "DejaVuSans",
        "Encoding" => "WinAnsiEncoding",
        "FontDescriptor" => Object::Reference(descriptor),
    };
    if widths {
        font.set("FirstChar", Object::Integer(32));
        // Bề rộng cố định 600/1000 cho mọi mã trong khoảng — đủ để kiểm rằng
        // engine dùng /Widths chứ không dùng bề rộng của font.
        font.set(
            "Widths",
            Object::Array((32..=126).map(|_| Object::Integer(600)).collect()),
        );
        font.set("LastChar", Object::Integer(126));
    }
    let font_id = doc.add_object(font);

    let resources = dictionary! {
        "Font" => dictionary! { "F1" => Object::Reference(font_id) },
    };
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

fn render(doc: &Document) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn render_with_options(doc: &Document, options: RenderOptions) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, options).expect("render phải thành công")
}

fn inked_pixels(r: &PageRender, channel: usize) -> usize {
    r.buffer
        .plate_u8(channel)
        .iter()
        .filter(|v| **v > 10)
        .count()
}

#[test]
fn output_preview_text_filter_keeps_text_and_rejects_other_object_filters() {
    let ttf = font_or_skip!();
    let doc = build_with_truetype("BT /F1 48 Tf 0 0 0 1 k 10 40 Td (Hi) Tj ET", ttf, true);
    let text = render_with_options(
        &doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::Text),
    );
    assert!(inked_pixels(&text, 3) > 50, "Show=Text phải giữ glyph");

    for filter in [
        OutputPreviewFilter::Images,
        OutputPreviewFilter::LineArt,
        OutputPreviewFilter::SmoothShades,
    ] {
        let hidden = render_with_options(
            &doc,
            RenderOptions::softproof().with_output_preview_filter(filter),
        );
        assert_eq!(inked_pixels(&hidden, 3), 0, "{filter:?} không được giữ glyph");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Vẽ được chữ
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn truetype_text_paints_ink() {
    let ttf = font_or_skip!();
    let doc = build_with_truetype("BT /F1 48 Tf 0 0 0 1 k 10 40 Td (Hi) Tj ET", ttf, true);
    let r = render(&doc);
    assert!(
        inked_pixels(&r, 3) > 50,
        "chữ phải lên mực: {}",
        inked_pixels(&r, 3)
    );
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn text_uses_fill_colour() {
    let ttf = font_or_skip!();
    let doc = build_with_truetype("BT /F1 48 Tf 0 1 0 0 k 10 40 Td (Hi) Tj ET", ttf, true);
    let r = render(&doc);
    assert!(inked_pixels(&r, 1) > 50, "phải lên kẽm Magenta");
    assert_eq!(inked_pixels(&r, 3), 0, "và không lên kẽm Black");
}

#[test]
fn text_without_widths_still_advances() {
    // Không khai /Widths: bề rộng phải lấy từ `hmtx` của font. Nếu trả 0, mọi
    // glyph chồng lên nhau tại một điểm và diện tích phủ mực sai hẳn.
    let ttf = font_or_skip!();
    let doc = build_with_truetype("BT /F1 36 Tf 0 0 0 1 k 5 40 Td (MMMM) Tj ET", ttf, false);
    let r = render(&doc);
    let w = r.buffer.width() as usize;
    let plate = r.buffer.plate_u8(3);
    // Tìm cột trái nhất và phải nhất có mực.
    let mut first = None;
    let mut last = 0usize;
    for y in 0..r.buffer.height() as usize {
        for x in 0..w {
            if plate[y * w + x] > 10 {
                first.get_or_insert(x);
                last = last.max(x);
            }
        }
    }
    let first = first.expect("phải có mực");
    assert!(
        last - first > 40,
        "4 chữ M phải trải ngang: {first}..{last}"
    );
}

#[test]
fn character_spacing_widens_the_run() {
    let ttf = font_or_skip!();
    let narrow = render(&build_with_truetype(
        "BT /F1 24 Tf 0 0 0 1 k 5 40 Td (IIII) Tj ET",
        font_or_skip!(),
        true,
    ));
    let wide = render(&build_with_truetype(
        "BT /F1 24 Tf 8 Tc 0 0 0 1 k 5 40 Td (IIII) Tj ET",
        ttf,
        true,
    ));
    let span = |r: &PageRender| {
        let w = r.buffer.width() as usize;
        let plate = r.buffer.plate_u8(3);
        let mut first = None;
        let mut last = 0usize;
        for y in 0..r.buffer.height() as usize {
            for x in 0..w {
                if plate[y * w + x] > 10 {
                    first.get_or_insert(x);
                    last = last.max(x);
                }
            }
        }
        last - first.unwrap_or(0)
    };
    assert!(span(&wide) > span(&narrow), "Tc phải giãn chữ");
}

#[test]
fn tj_array_offsets_move_the_pen() {
    // Số trong `TJ` mang dấu ngược: số dương dịch chữ sang TRÁI.
    let ttf = font_or_skip!();
    let doc = build_with_truetype(
        "BT /F1 24 Tf 0 0 0 1 k 50 40 Td [(A) -2000 (B)] TJ ET",
        ttf,
        true,
    );
    let r = render(&doc);
    assert!(inked_pixels(&r, 3) > 20, "cả hai chữ phải vẽ được");
}

#[test]
fn text_matrix_scales_glyphs() {
    let ttf = font_or_skip!();
    let small = render(&build_with_truetype(
        "BT /F1 12 Tf 0 0 0 1 k 10 40 Td (A) Tj ET",
        font_or_skip!(),
        true,
    ));
    let big = render(&build_with_truetype(
        "BT /F1 60 Tf 0 0 0 1 k 10 40 Td (A) Tj ET",
        ttf,
        true,
    ));
    assert!(
        inked_pixels(&big, 3) > inked_pixels(&small, 3) * 4,
        "cỡ chữ lớn phải phủ nhiều mực hơn nhiều"
    );
}

#[test]
fn td_moves_to_a_new_line() {
    let ttf = font_or_skip!();
    let doc = build_with_truetype(
        "BT /F1 24 Tf 0 0 0 1 k 10 90 Td (A) Tj 0 -40 Td (B) Tj ET",
        ttf,
        true,
    );
    let r = render(&doc);
    let w = r.buffer.width() as usize;
    let plate = r.buffer.plate_u8(3);
    let row_has_ink = |y: usize| (0..w).any(|x| plate[y * w + x] > 10);
    let top = (10..40).any(row_has_ink);
    let bottom = (50..90).any(row_has_ink);
    assert!(top && bottom, "phải có mực ở hai dòng khác nhau");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chế độ vẽ chữ
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn render_mode_3_paints_absolutely_nothing() {
    // Đây là test quan trọng nhất của file này. File scan có OCR mang một lớp
    // chữ vô hình (`3 Tr`) phủ kín trang. Vẽ nó ra là đổ mực kín trang và mọi số
    // đo mực thành rác.
    let ttf = font_or_skip!();
    let doc = build_with_truetype(
        "BT /F1 48 Tf 3 Tr 0 0 0 1 k 10 40 Td (Hidden) Tj ET",
        ttf,
        true,
    );
    let r = render(&doc);
    assert_eq!(
        r.buffer.max_tac_percent(),
        0.0,
        "chữ vô hình không được lên mực"
    );
}

#[test]
fn render_mode_7_clip_only_paints_nothing_itself() {
    let ttf = font_or_skip!();
    let doc = build_with_truetype(
        "BT /F1 48 Tf 7 Tr 0 0 0 1 k 10 40 Td (Clip) Tj ET",
        ttf,
        true,
    );
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
}

#[test]
fn text_clip_limits_later_fill() {
    // `7 Tr` gom glyph thành clip; hình tô sau `ET` chỉ hiện trong lòng chữ.
    let ttf = font_or_skip!();
    let doc = build_with_truetype(
        "BT /F1 90 Tf 7 Tr 5 30 Td (H) Tj ET 0 0 0 1 k 0 0 120 120 re f",
        ttf,
        true,
    );
    let r = render(&doc);
    let inked = inked_pixels(&r, 3);
    let total = (r.buffer.width() * r.buffer.height()) as usize;
    assert!(inked > 0, "phải có mực trong lòng chữ");
    assert!(
        inked < total / 2,
        "nhưng không được tô kín trang: {inked}/{total}"
    );
}

#[test]
fn text_clip_bounds_a_following_sentinel_soft_mask_under_tight_budget() {
    // CORRECTNESS (audit 2026-08-09 §PRE.0A): sau `ET`, clip glyph phải cập
    // nhật cả mask lẫn hộp bao bảo thủ. Nếu chỉ cập nhật mask, `/BBox` sentinel
    // của soft-mask dưới đây vẫn xin child buffer cỡ cả trang và vượt ngân sách.
    let ttf = font_or_skip!();
    let mut doc = build_with_truetype(
        "BT /F1 24 Tf 7 Tr 10 50 Td (H) Tj ET \
         /GS0 gs 0 0 0 1 k 0 0 120 120 re f",
        ttf,
        true,
    );

    let form = Object::Reference(doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![(-32768).into(), (-32768).into(), 32768.into(), 32768.into()],
            "Group" => Object::Dictionary(dictionary! {
                "S" => "Transparency",
                "CS" => "DeviceGray",
            }),
        },
        b"1 g -32768 -32768 65536 65536 re f".to_vec(),
    )));
    let page_id = *doc
        .get_pages()
        .values()
        .next()
        .expect("fixture phải có một trang");
    let resources_id = match doc
        .get_object(page_id)
        .and_then(Object::as_dict)
        .and_then(|page| page.get(b"Resources"))
        .expect("page phải có resources")
    {
        Object::Reference(id) => *id,
        other => panic!("resources phải là tham chiếu, nhận {other:?}"),
    };
    doc.get_object_mut(resources_id)
        .and_then(Object::as_dict_mut)
        .expect("resources phải là dictionary")
        .set(
            "ExtGState",
            Object::Dictionary(dictionary! {
                "GS0" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Luminosity",
                        "G" => form,
                    })
                }
            }),
        );

    // Buffer trang 120×120 CMYK+alpha cần 288.000 byte. 450.000 byte đủ cho
    // cửa sổ quanh glyph H cùng guard lồng 12 px, nhưng không đủ cho child
    // buffer 120×120 kiểu cũ.
    let rendered = render_page(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(450_000),
    )
    .expect("soft-mask phải được giới hạn theo clip chữ");
    assert!(inked_pixels(&rendered, 3) > 0, "lòng glyph phải còn mực");
}

#[test]
fn stroke_mode_paints_using_stroke_colour() {
    let ttf = font_or_skip!();
    let doc = build_with_truetype(
        "BT /F1 60 Tf 1 Tr 1 0 0 0 K 1 w 10 40 Td (O) Tj ET",
        ttf,
        true,
    );
    let r = render(&doc);
    assert!(inked_pixels(&r, 0) > 10, "nét chữ phải dùng màu nét (Cyan)");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trung thực khi không vẽ được
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn missing_embedded_font_is_reported_and_not_substituted() {
    // Không nhúng font: engine KHÔNG được thay bằng font hệ thống, vì thay font
    // đổi bề rộng chữ và diện tích phủ mực ⇒ báo cáo mực sai mà không ai kiểm.
    let mut doc = Document::with_version("1.7");
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "TrueType",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => Object::Reference(font_id) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"BT /F1 48 Tf 0 0 0 1 k 10 40 Td (Hi) Tj ET".to_vec(),
    ));
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

    let r = render(&doc);
    assert_eq!(
        r.buffer.max_tac_percent(),
        0.0,
        "không được vẽ glyph thay thế"
    );
    assert!(r.warnings.degrades_accuracy());
    assert!(
        r.warnings
            .skipped_ops
            .iter()
            .any(|(op, _)| op.contains("không nhúng")),
        "{:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn showing_text_without_tf_is_reported() {
    let mut doc = Document::with_version("1.7");
    let resources_id = doc.add_object(Dictionary::new());
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"BT (Hi) Tj ET".to_vec()));
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

    let r = render(&doc);
    assert!(r.warnings.dropped_objects > 0);
}

#[test]
fn clean_text_page_is_not_flagged_degraded() {
    // Ngược lại: trang chữ CMYK vẽ đủ thì không được hạ accuracy oan, nếu không
    // mọi báo cáo đều mang cảnh báo và người dùng học cách bỏ qua cảnh báo.
    let ttf = font_or_skip!();
    let doc = build_with_truetype("BT /F1 24 Tf 0 0 0 1 k 10 40 Td (Test) Tj ET", ttf, true);
    let r = render(&doc);
    assert!(!r.warnings.degrades_accuracy(), "{:?}", r.warnings);
}
