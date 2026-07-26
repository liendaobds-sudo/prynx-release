//! Test tích hợp tiling pattern (`/PatternType 1`).
//!
//! Với prepress, tiling pattern là một trong ít chỗ mà **diện tích phủ** là con số
//! quyết định: một mẫu gạch chéo 50% cho ra đúng một nửa lượng mực của vùng đặc.
//! Không có cách nào xấp xỉ — tô một màu phẳng thay ô mẫu là bịa số.
//!
//! Bốn thứ được chốt ở đây:
//!
//! 1. Ô mẫu lặp đúng theo `/XStep`/`/YStep`, và diện tích phủ khớp tỉ lệ của ô.
//! 2. Pattern bị giới hạn bởi **đường dẫn**, không phải bởi clip.
//! 3. `/PaintType 2` (uncoloured) lấy màu từ `scn` bên ngoài và **bỏ qua** mọi
//!    operator màu trong ô — nếu không, mẫu sẽ ra đen thay vì màu file yêu cầu.
//! 4. Số ô vượt trần thì **báo thiếu tính năng**, không vẽ một phần: vẽ một phần cho
//!    lượng mực thấp hơn thực tế.

use lopdf::{dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 40;

/// Dựng trang dùng một tiling pattern có content `cell`.
#[allow(clippy::too_many_arguments)]
fn render_pattern(
    content: &str,
    cell: &str,
    bbox: [i64; 4],
    xstep: i64,
    ystep: i64,
    paint_type: i64,
    pattern_cs: Object,
    matrix: Option<Vec<Object>>,
) -> PageRender {
    let mut doc = Document::with_version("1.7");
    let mut pdict = dictionary! {
        "Type" => "XObject",
        "PatternType" => 1,
        "PaintType" => paint_type,
        "TilingType" => 1,
        "BBox" => vec![bbox[0].into(), bbox[1].into(), bbox[2].into(), bbox[3].into()],
        "XStep" => xstep,
        "YStep" => ystep,
        "Resources" => dictionary! {},
    };
    if let Some(m) = matrix {
        pdict.set("Matrix", Object::Array(m));
    }
    let pattern = doc.add_object(Stream::new(pdict, cell.as_bytes().to_vec()));

    let resources = doc.add_object(dictionary! {
        "Pattern" => dictionary! { "P0" => Object::Reference(pattern) },
        "ColorSpace" => dictionary! { "CS0" => pattern_cs },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
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

    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn plain_pattern_cs() -> Object {
    Object::Array(vec![Object::Name(b"Pattern".to_vec())])
}

fn uncoloured_pattern_cs() -> Object {
    Object::Array(vec![
        Object::Name(b"Pattern".to_vec()),
        Object::Name(b"DeviceCMYK".to_vec()),
    ])
}

fn px(r: &PageRender, channel: usize, x: usize, y: usize) -> u8 {
    r.buffer.plate_u8(channel)[y * r.buffer.width() as usize + x]
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ô mẫu đặc — kiểm việc lặp
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn solid_cell_fills_the_whole_path() {
    // Ô đặc bằng đúng bước ⇒ mẫu phủ kín ⇒ tương đương tô đặc.
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 0 1 k 0 0 10 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        None,
    );
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
    assert_eq!(px(&r, 3, 2, 2), 255);
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    assert!(!r.warnings.ink_unsound(), "{:?}", r.warnings);
}

#[test]
fn half_covered_cell_gives_half_the_coverage() {
    // Ô 10×10 chỉ tô nửa trái ⇒ diện tích phủ mực phải ~50%. Đây là con số mà mọi
    // cách xấp xỉ đều làm sai.
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 0 1 k 0 0 5 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        None,
    );
    let cov = r.buffer.plate_coverage_pct(3);
    assert!((cov - 50.0).abs() < 3.0, "độ phủ phải ~50%: {cov}");
    // Chỗ có mực vẫn phải đặc 100%: mẫu không được làm loãng mực.
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
}

#[test]
fn cell_repeats_across_the_page() {
    // Ô tô 2pt đầu của mỗi bước 10pt ⇒ 4 vạch trên trang 40pt. Kiểm bằng cách đếm
    // số lần chuyển trạng thái theo một hàng.
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 0 1 k 0 0 2 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        None,
    );
    let w = r.buffer.width() as usize;
    let k = r.buffer.plate_u8(3);
    let row = (r.buffer.height() as usize / 2) * w;
    let mut bands = 0;
    let mut prev = 0u8;
    for x in 0..w {
        let v = k[row + x];
        if v > 128 && prev <= 128 {
            bands += 1;
        }
        prev = v;
    }
    assert_eq!(bands, 4, "phải có 4 vạch trên trang 40pt với bước 10pt");
}

#[test]
fn pattern_is_bounded_by_the_path_not_the_clip() {
    // Nhầm hai đường này làm mẫu tràn ra ngoài hình cần tô.
    let half = PAGE / 2;
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {half} {PAGE} re f"),
        "0 0 0 1 k 0 0 10 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        None,
    );
    let w = r.buffer.width() as usize;
    let y = r.buffer.height() as usize / 2;
    assert_eq!(px(&r, 3, 2, y), 255, "trong đường dẫn phải có mực");
    assert_eq!(px(&r, 3, w - 3, y), 0, "ngoài đường dẫn phải trắng");
}

#[test]
fn pattern_matrix_scales_the_cell() {
    // `/Matrix [2 0 0 2 0 0]` phóng ô lên 2× ⇒ bước thiết bị 20pt ⇒ 2 vạch.
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 0 1 k 0 0 2 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        Some(vec![
            2.into(),
            0.into(),
            0.into(),
            2.into(),
            0.into(),
            0.into(),
        ]),
    );
    let w = r.buffer.width() as usize;
    let k = r.buffer.plate_u8(3);
    let row = (r.buffer.height() as usize / 2) * w;
    let mut bands = 0;
    let mut prev = 0u8;
    for x in 0..w {
        let v = k[row + x];
        if v > 128 && prev <= 128 {
            bands += 1;
        }
        prev = v;
    }
    assert_eq!(bands, 2, "/Matrix phải phóng cả bước lặp");
}

#[test]
fn content_outside_the_cell_bbox_is_clipped() {
    // Ô vẽ tràn ra ngoài `/BBox`; `/BBox` là clip bắt buộc (§8.7.3.1). Không cắt thì
    // các ô đè lên nhau và lượng mực đo được cao hơn thực tế.
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f"),
        // BBox 5×10 nhưng vẽ 10×10.
        "0 0 0 1 k 0 0 10 10 re f",
        [0, 0, 5, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        None,
    );
    let cov = r.buffer.plate_coverage_pct(3);
    assert!(
        (cov - 50.0).abs() < 3.0,
        "phải bị cắt về nửa ô ⇒ ~50%, đo được {cov}"
    );
}

#[test]
fn spot_colour_inside_a_cell_gets_its_own_plate() {
    let mut doc = Document::with_version("1.7");
    let sep = Object::Array(vec![
        Object::Name(b"Separation".to_vec()),
        Object::Name(b"CutContour".to_vec()),
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
    let cell_res = doc.add_object(dictionary! { "ColorSpace" => dictionary! { "S0" => sep } });
    let pattern = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "XStep" => 10,
            "YStep" => 10,
            "Resources" => Object::Reference(cell_res),
        },
        b"/S0 cs 1 scn 0 0 10 10 re f".to_vec(),
    ));
    let resources = doc.add_object(dictionary! {
        "Pattern" => dictionary! { "P0" => Object::Reference(pattern) },
        "ColorSpace" => dictionary! { "CS0" => plain_pattern_cs() },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f").into_bytes(),
    ));
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
    let names: Vec<&str> = r.buffer.space().colorants().iter().map(|c| c.name()).collect();
    assert!(names.contains(&"CutContour"), "{names:?}");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Uncoloured (`/PaintType 2`)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn uncoloured_pattern_takes_its_colour_from_scn() {
    // Ô không khai màu; màu là toán hạng của `scn`. Ở đây là Cyan 100%.
    let r = render_pattern(
        &format!("/CS0 cs 1 0 0 0 /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 10 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        2,
        uncoloured_pattern_cs(),
        None,
    );
    assert_eq!(px(&r, 0, 2, 2), 255, "phải là Cyan của `scn`");
    assert_eq!(px(&r, 3, 2, 2), 0, "không được ra đen");
}

#[test]
fn colour_operators_inside_an_uncoloured_cell_are_ignored() {
    // Ô uncoloured tự đặt `0 0 0 1 k`. Spec nói bỏ qua (§8.7.3.3). Nếu không bỏ, mẫu
    // ra đen và mất hẳn màu mà file yêu cầu — sai cả kẽm lẫn lượng mực.
    let r = render_pattern(
        &format!("/CS0 cs 1 0 0 0 /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 0 1 k 0 0 10 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        2,
        uncoloured_pattern_cs(),
        None,
    );
    assert_eq!(px(&r, 0, 2, 2), 255, "vẫn phải là Cyan");
    assert_eq!(px(&r, 3, 2, 2), 0, "operator màu trong ô phải bị bỏ qua");
}

#[test]
fn uncoloured_pattern_without_base_colourspace_is_reported() {
    // `/Pattern` không có colorspace nền ⇒ không biết `scn` mang màu gì. Không đoán.
    let r = render_pattern(
        &format!("/CS0 cs 1 0 0 0 /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 10 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        2,
        plain_pattern_cs(),
        None,
    );
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert!(r.warnings.dropped_objects > 0);
    assert!(r.warnings.ink_unsound());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Giới hạn và file hỏng
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn too_many_tiles_is_reported_instead_of_partially_drawn() {
    // Bước rất nhỏ ⇒ số ô vượt trần. Vẽ một phần sẽ cho lượng mực thấp hơn thực tế,
    // nên engine phải báo thiếu tính năng và nhường Ghostscript.
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 0 1 k 0 0 1 1 re f",
        [0, 0, 1, 1],
        1,
        1,
        1,
        plain_pattern_cs(),
        // Thu nhỏ 20× ⇒ bước 0.05pt ⇒ hàng trăm nghìn ô.
        Some(vec![
            Object::Real(0.05),
            0.into(),
            0.into(),
            Object::Real(0.05),
            0.into(),
            0.into(),
        ]),
    );
    assert!(r.warnings.dropped_objects > 0, "phải báo vượt trần");
    assert!(r.warnings.ink_unsound());
    assert!(
        r.warnings
            .skipped_ops
            .iter()
            .any(|(op, _)| op.contains("vượt trần")),
        "{:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn zero_step_is_rejected_instead_of_looping_forever() {
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 {PAGE} {PAGE} re f"),
        "0 0 0 1 k 0 0 10 10 re f",
        [0, 0, 10, 10],
        0,
        0,
        1,
        plain_pattern_cs(),
        None,
    );
    // Bước 0 ⇒ lùi về bề rộng `/BBox` (10) ⇒ vẫn vẽ được, không treo.
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
}

#[test]
fn pattern_name_without_pattern_colourspace_is_not_used() {
    // Tên pattern còn sót sau khi `cs` đã đổi: tuyệt đối không được tô gradient/mẫu
    // lên hình đáng lẽ tô màu phẳng.
    let r = render_pattern(
        &format!("/CS0 cs /P0 scn 0 0 0 1 k 0 0 {PAGE} {PAGE} re f"),
        "1 0 0 0 k 0 0 10 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        None,
    );
    // `k` đã đổi colorspace sang DeviceCMYK ⇒ tô đen thường, không dùng pattern.
    assert_eq!(px(&r, 3, 2, 2), 255);
    assert_eq!(px(&r, 0, 2, 2), 0, "không được dùng Cyan của ô mẫu");
}

#[test]
fn tiling_pattern_can_stroke_as_well_as_fill() {
    let r = render_pattern(
        &format!("/CS0 CS /P0 SCN 4 w 0 20 m {PAGE} 20 l S"),
        "0 0 0 1 k 0 0 10 10 re f",
        [0, 0, 10, 10],
        10,
        10,
        1,
        plain_pattern_cs(),
        None,
    );
    let w = r.buffer.width() as usize;
    let k = r.buffer.plate_u8(3);
    let mid = (r.buffer.height() as usize / 2) * w + w / 2;
    assert_eq!(k[mid], 255, "nét phải được tô bằng mẫu");
    assert_eq!(k[2 * w + w / 2], 0, "ngoài nét phải trắng");
}
