//! Thu thập đường viền glyph cho action `OUTLINE_FONTS` (kế hoạch §19.7).
//!
//! Điều được khoá ở đây không phải "có path" mà là ba tính chất khiến path dùng
//! được để **ghi lại PDF**:
//!
//! 1. path nằm trong không gian người dùng của stream (chỉ ma trận chữ, KHÔNG có
//!    CTM) — nhân CTM ở đây là nhân hai lần, và chỉ lộ trên trang có `cm`;
//! 2. mỗi glyph biết mình thuộc content stream nào và khối `BT … ET` thứ mấy;
//! 3. mọi thứ engine **không** chuyển được (Type3, chữ trong soft mask/pattern,
//!    glyph tra không ra) đều được khai ra, vì bỏ qua âm thầm nghĩa là chữ biến mất
//!    khỏi bản in.

use std::path::{Path, PathBuf};

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};
use print_engine::text::outlines::{verb, StreamKey};

const PAGE: i64 = 200;

fn font_bytes() -> Option<Vec<u8>> {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("backend/app/assets/fonts/DejaVuSans.ttf");
    std::fs::read(path).ok()
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

fn embed_font(doc: &mut Document, ttf: Vec<u8>) -> Dictionary {
    let font_file = doc.add_object(Stream::new(
        dictionary! { "Length1" => ttf.len() as i64 },
        ttf,
    ));
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "DejaVuSans",
        "Flags" => 32,
        "ItalicAngle" => 0,
        "Ascent" => 900,
        "Descent" => -200,
        "CapHeight" => 700,
        "StemV" => 80,
        "FontBBox" => vec![(-1021).into(), (-463).into(), 1793.into(), 1232.into()],
        "FontFile2" => Object::Reference(font_file),
    });
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "TrueType",
        "BaseFont" => "DejaVuSans",
        "Encoding" => "WinAnsiEncoding",
        "FontDescriptor" => Object::Reference(descriptor),
    });
    dictionary! { "Font" => dictionary! { "F1" => Object::Reference(font_id) } }
}

/// Dựng PDF một trang; `extra_res` cho phép thêm XObject vào resources.
fn build(
    content: &str,
    ttf: Vec<u8>,
    extra: Option<&dyn Fn(&mut Document, &mut Dictionary)>,
) -> Document {
    let mut doc = Document::with_version("1.7");
    let mut resources = embed_font(&mut doc, ttf);
    if let Some(f) = extra {
        f(&mut doc, &mut resources);
    }
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

fn collect(doc: &Document) -> PageRender {
    render_page(
        doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::collecting_text_outlines(),
    )
    .expect("thu thập outline phải thành công")
}

/// Hộp bao của mọi toạ độ đã thu thập.
fn bbox(r: &PageRender) -> (f32, f32, f32, f32) {
    let mut b = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for g in &r.text_outlines.glyphs {
        for xy in g.coords.chunks(2) {
            b.0 = b.0.min(xy[0]);
            b.1 = b.1.min(xy[1]);
            b.2 = b.2.max(xy[0]);
            b.3 = b.3.max(xy[1]);
        }
    }
    b
}

#[test]
fn collects_one_path_per_glyph_in_draw_order() {
    let ttf = font_or_skip!();
    let doc = build("BT /F1 24 Tf 20 100 Td (AB) Tj ET", ttf, None);
    let r = collect(&doc);
    let g = &r.text_outlines.glyphs;
    assert_eq!(g.len(), 2, "hai glyph phải ra hai path");
    assert_eq!(g[0].glyph_index, 0);
    assert_eq!(g[1].glyph_index, 1);
    assert!(g.iter().all(|x| x.stream == StreamKey::Page));
    assert!(g.iter().all(|x| x.text_object_index == 0));
    assert!(g.iter().all(|x| x.fill && !x.stroke && !x.clip));
    assert!(g[0].verbs.contains(&verb::MOVE) && g[0].verbs.contains(&verb::CLOSE));
    assert!(r.text_outlines.is_complete(), "{:?}", r.text_outlines);
}

#[test]
fn path_is_in_stream_user_space_not_device_space() {
    // Đây là bất biến sống còn: `cm` vẫn nằm trong stream sau khi Python thay khối
    // `BT … ET`, nên path KHÔNG được mang CTM. Trang này phóng đại 3× bằng `cm`;
    // nếu path mang CTM thì hộp bao sẽ nhân 3 (bug §3.8 của kế hoạch).
    let ttf = font_or_skip!();
    let plain = build("BT /F1 24 Tf 20 100 Td (A) Tj ET", ttf.clone(), None);
    let scaled = build(
        "q 3 0 0 3 0 0 cm BT /F1 24 Tf 20 100 Td (A) Tj ET Q",
        ttf,
        None,
    );
    let a = bbox(&collect(&plain));
    let b = bbox(&collect(&scaled));
    assert!((a.0 - b.0).abs() < 0.01, "{a:?} vs {b:?}");
    assert!((a.1 - b.1).abs() < 0.01, "{a:?} vs {b:?}");
    assert!((a.2 - b.2).abs() < 0.01, "{a:?} vs {b:?}");
    assert!((a.3 - b.3).abs() < 0.01, "{a:?} vs {b:?}");
}

#[test]
fn text_matrix_is_applied_so_glyph_lands_where_it_is_drawn() {
    let ttf = font_or_skip!();
    let doc = build("BT /F1 24 Tf 20 100 Td (A) Tj ET", ttf, None);
    let b = bbox(&collect(&doc));
    // `Td 20 100` + cỡ 24pt: glyph phải nằm quanh (20, 100), không phải quanh gốc.
    assert!(b.0 > 15.0 && b.0 < 30.0, "x trái {b:?}");
    assert!(b.1 > 95.0 && b.1 < 110.0, "y dưới {b:?}");
    assert!(b.3 - b.1 > 8.0, "chiều cao chữ 24pt quá nhỏ: {b:?}");
}

#[test]
fn each_text_object_gets_its_own_index() {
    let ttf = font_or_skip!();
    let doc = build(
        "BT /F1 24 Tf 20 40 Td (A) Tj ET BT /F1 24 Tf 20 90 Td (B) Tj ET",
        ttf,
        None,
    );
    let r = collect(&doc);
    let idx: Vec<u32> = r
        .text_outlines
        .glyphs
        .iter()
        .map(|g| g.text_object_index)
        .collect();
    assert_eq!(idx, vec![0, 1], "mốc thay khối BT…ET phải tăng theo khối");
}

#[test]
fn text_inside_form_xobject_is_tagged_with_that_form() {
    let ttf = font_or_skip!();
    let form_content = b"BT /F1 24 Tf 5 5 Td (A) Tj ET".to_vec();
    let add_form = |doc: &mut Document, res: &mut Dictionary| {
        let inner_res = res.clone();
        let inner_res_id = doc.add_object(inner_res);
        let id = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                "Resources" => Object::Reference(inner_res_id),
            },
            form_content.clone(),
        ));
        res.set("XObject", dictionary! { "X1" => Object::Reference(id) });
        // Ghi lại để test so sánh — dùng Cell vì closure là Fn.
        FORM_ID.with(|c| c.set(Some(id)));
    };
    let doc = build("q 1 0 0 1 30 30 cm /X1 Do Q", ttf, Some(&add_form));
    let form_obj_id = FORM_ID.with(|c| c.get());
    let r = collect(&doc);
    let g = &r.text_outlines.glyphs;
    assert_eq!(g.len(), 1, "chữ trong form vẫn phải được thu thập");
    let (id, gen) = form_obj_id.expect("form phải có object id");
    assert_eq!(
        g[0].stream,
        StreamKey::Form(id, gen),
        "chữ trong form phải mang khoá stream của form, không phải của trang"
    );
    assert_eq!(
        g[0].text_object_index, 0,
        "bộ đếm khối BT của form là riêng"
    );
}

#[test]
fn form_counter_does_not_leak_into_the_page_counter() {
    let ttf = font_or_skip!();
    let form_content = b"BT /F1 24 Tf 5 5 Td (A) Tj ET".to_vec();
    let add_form = |doc: &mut Document, res: &mut Dictionary| {
        let inner_res_id = doc.add_object(res.clone());
        let id = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                "Resources" => Object::Reference(inner_res_id),
            },
            form_content.clone(),
        ));
        res.set("XObject", dictionary! { "X1" => Object::Reference(id) });
    };
    // Khối BT của trang: một trước form, một sau form ⇒ chỉ số phải là 0 rồi 1.
    let doc = build(
        "BT /F1 24 Tf 10 10 Td (A) Tj ET /X1 Do BT /F1 24 Tf 10 150 Td (B) Tj ET",
        ttf,
        Some(&add_form),
    );
    let r = collect(&doc);
    let page_idx: Vec<u32> = r
        .text_outlines
        .glyphs
        .iter()
        .filter(|g| g.stream == StreamKey::Page)
        .map(|g| g.text_object_index)
        .collect();
    assert_eq!(page_idx, vec![0, 1], "bộ đếm của trang bị form làm lệch");
}

#[test]
fn invisible_text_mode_is_not_counted_as_lost_text() {
    let ttf = font_or_skip!();
    // `Tr 3` = chữ vô hình có chủ đích (lớp OCR). Không có gì để outline, và cũng
    // KHÔNG phải chữ bị mất — gộp hai thứ này sẽ chặn oan mọi PDF đã OCR.
    let doc = build("BT /F1 24 Tf 3 Tr 20 100 Td (A) Tj ET", ttf, None);
    let r = collect(&doc);
    assert!(r.text_outlines.glyphs.is_empty());
    assert_eq!(r.text_outlines.missing_glyphs, 0);
    assert!(r.text_outlines.is_complete());
}

#[test]
fn stroked_text_reports_stroke_and_line_width() {
    let ttf = font_or_skip!();
    let doc = build("BT /F1 24 Tf 2 w 1 Tr 20 100 Td (A) Tj ET", ttf, None);
    let r = collect(&doc);
    let g = &r.text_outlines.glyphs;
    assert_eq!(g.len(), 1);
    assert!(g[0].stroke && !g[0].fill, "Tr 1 là vẽ nét, không tô");
    assert!((g[0].line_width - 2.0).abs() < 1e-4, "{}", g[0].line_width);
}

#[test]
fn missing_embedded_font_is_reported_so_caller_can_refuse() {
    // Font không nhúng ⇒ glyph lấy từ font thay thế. Ở đây không truyền font thay
    // thế nên không tra được glyph nào; con số này là thứ chặn bản in mất chữ.
    let mut doc = Document::with_version("1.7");
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "TrueType",
        "BaseFont" => "KhongTonTai",
        "Encoding" => "WinAnsiEncoding",
    });
    let resources = dictionary! { "Font" => dictionary! { "F1" => Object::Reference(font_id) } };
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"BT /F1 24 Tf 20 100 Td (AB) Tj ET".to_vec(),
    ));
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

    let r = collect(&doc);
    assert!(
        r.text_outlines.missing_glyphs > 0,
        "glyph không tra được phải được khai: {:?}",
        r.text_outlines
    );
    assert!(!r.text_outlines.is_complete());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hợp đồng đếm mã ký tự (OUT-FONT, audit lần 3 §3.2)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn block_code_count_includes_spaces_and_invisible_text() {
    // Con số này là hợp đồng đồng bộ chỉ số với bộ ghi PDF bên Python: nó phải đếm
    // MỌI mã ký tự. Đếm chỉ những glyph vẽ được sẽ làm hai bên lệch ngay ở dấu cách
    // và path bị gán cho glyph khác.
    let ttf = font_or_skip!();
    let doc = build("BT /F1 24 Tf 20 100 Td (A B) Tj ET", ttf, None);
    let r = collect(&doc);
    assert_eq!(
        r.text_outlines.blocks.len(),
        1,
        "{:?}",
        r.text_outlines.blocks
    );
    let b = &r.text_outlines.blocks[0];
    assert_eq!(b.stream, StreamKey::Page);
    assert_eq!(b.text_object_index, 0);
    assert_eq!(b.code_count, 3, "dấu cách vẫn phải được đếm");
    // Chỉ 2 glyph có path (dấu cách rỗng) — đúng chỗ hai con số phải khác nhau.
    assert_eq!(r.text_outlines.glyphs.len(), 2);
}

#[test]
fn each_block_reports_its_own_code_count() {
    let ttf = font_or_skip!();
    let doc = build(
        "BT /F1 24 Tf 20 40 Td (A) Tj ET BT /F1 24 Tf 20 90 Td (BCD) Tj ET",
        ttf,
        None,
    );
    let r = collect(&doc);
    let counts: Vec<(u32, u32)> = r
        .text_outlines
        .blocks
        .iter()
        .map(|b| (b.text_object_index, b.code_count))
        .collect();
    assert_eq!(counts, vec![(0, 1), (1, 3)], "{counts:?}");
}

#[test]
fn invisible_text_still_counts_so_indices_stay_aligned() {
    // `Tr 3` không sinh path nào, nhưng bộ ghi Python vẫn duyệt qua các mã đó. Nếu
    // engine không đếm chúng thì hai bên lệch số và cả khối bị loại oan.
    let ttf = font_or_skip!();
    let doc = build("BT /F1 24 Tf 3 Tr 20 100 Td (ABC) Tj ET", ttf, None);
    let r = collect(&doc);
    assert!(r.text_outlines.glyphs.is_empty());
    assert_eq!(r.text_outlines.blocks.len(), 1);
    assert_eq!(r.text_outlines.blocks[0].code_count, 3);
}

#[test]
fn visible_glyph_after_invisible_run_keeps_the_python_ordinal() {
    // Hồi quy có thật: khi việc đếm còn nằm sau cổng `paints_ink`, khối này cho engine
    // ordinal 0,1 trong khi bộ ghi Python đếm 3,4 — path của `X` bị gán cho `a`. File
    // vẫn mở được, vẫn có chữ, chỉ sai chỗ, và chỉ thấy khi đã in.
    let ttf = font_or_skip!();
    let doc = build(
        "BT /F1 24 Tf 20 100 Td 3 Tr (abc) Tj 0 Tr (XY) Tj ET",
        ttf,
        None,
    );
    let r = collect(&doc);
    let idx: Vec<u32> = r
        .text_outlines
        .glyphs
        .iter()
        .map(|g| g.glyph_index)
        .collect();
    assert_eq!(
        idx,
        vec![3, 4],
        "chỉ số phải tính cả 3 mã vô hình phía trước"
    );
    assert_eq!(r.text_outlines.blocks[0].code_count, 5);
}

#[test]
fn form_invoked_twice_reports_the_count_once_not_doubled() {
    // Cộng dồn ở đây là bug thật chờ xảy ra: cùng một Form XObject được `Do` hai lần
    // sẽ khai 2× số mã, Python đếm ra 1× và loại oan toàn bộ chữ trong form.
    let ttf = font_or_skip!();
    let form_content = b"BT /F1 24 Tf 5 5 Td (AB) Tj ET".to_vec();
    let add_form = |doc: &mut Document, res: &mut Dictionary| {
        let inner_res_id = doc.add_object(res.clone());
        let id = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                "Resources" => Object::Reference(inner_res_id),
            },
            form_content.clone(),
        ));
        res.set("XObject", dictionary! { "X1" => Object::Reference(id) });
    };
    let doc = build(
        "q 1 0 0 1 20 20 cm /X1 Do Q q 1 0 0 1 20 120 cm /X1 Do Q",
        ttf,
        Some(&add_form),
    );
    let r = collect(&doc);
    let form_blocks: Vec<&print_engine::text::outlines::TextBlockCodes> = r
        .text_outlines
        .blocks
        .iter()
        .filter(|b| matches!(b.stream, StreamKey::Form(_, _)))
        .collect();
    assert_eq!(form_blocks.len(), 1, "{:?}", r.text_outlines.blocks);
    assert_eq!(
        form_blocks[0].code_count, 2,
        "số mã bị cộng dồn theo số lần Do"
    );
}

use std::cell::Cell;
thread_local! {
    static FORM_ID: Cell<Option<(u32, u16)>> = const { Cell::new(None) };
}
