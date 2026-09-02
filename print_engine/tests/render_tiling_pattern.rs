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
use rayon::ThreadPoolBuilder;

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

#[test]
fn blank_parallel_shading_pattern_does_not_commit_image_mask_warning() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A02/A05): fast path shading chỉ được
    // xem là sink paint nếu ít nhất một sample có alpha dương. Trục shading nằm
    // ngoài trang và không Extend nên toàn bộ sample là None.
    const LARGE_PAGE: i64 = 800;
    let mut doc = Document::with_version("1.7");
    let function = dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
        "N" => 1,
    };
    let shading = dictionary! {
        "ShadingType" => 2,
        "ColorSpace" => "DeviceCMYK",
        "Coords" => vec![2000.into(), 0.into(), 2100.into(), 0.into()],
        "Function" => Object::Dictionary(function),
        "Extend" => vec![Object::Boolean(false), Object::Boolean(false)],
    };
    let pattern_id = doc.add_object(dictionary! {
        "Type" => "Pattern",
        "PatternType" => 2,
        "Shading" => Object::Dictionary(shading),
    });
    let mut stencil = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 1,
        "Mask" => Object::Null,
    };
    stencil.set("ImageMask", Object::Boolean(true));
    let image_id = doc.add_object(Stream::new(stencil, vec![0]));
    let resources_id = doc.add_object(dictionary! {
        "Pattern" => dictionary! { "P0" => Object::Reference(pattern_id) },
        "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("/Pattern cs /P0 scn q {LARGE_PAGE} 0 0 {LARGE_PAGE} 0 0 cm /Im0 Do Q")
            .into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), LARGE_PAGE.into(), LARGE_PAGE.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let pool = ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .expect("phải dựng được pool test");
    let rendered = pool.install(|| {
        render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
            .expect("shading Pattern phải render được")
    });
    assert_eq!(rendered.buffer.max_tac_percent(), 0.0);
    assert!(
        !rendered.warnings.ink_unsound(),
        "Pattern không paint không được commit warning Mask: {:?}",
        rendered.warnings
    );
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
fn tiling_pattern_uses_the_enclosing_stream_initial_matrix() {
    let mut doc = Document::with_version("1.7");
    let pattern_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "XStep" => 10,
            "YStep" => 10,
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 0 0 5 10 re f".to_vec(),
    ));
    let form_resources = dictionary! {
        "Pattern" => dictionary! { "P0" => Object::Reference(pattern_id) },
        "ColorSpace" => dictionary! { "CS0" => plain_pattern_cs() },
    };
    let form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "Resources" => Object::Dictionary(form_resources),
        },
        b"2 0 0 2 0 0 cm /CS0 cs /P0 scn 0 0 20 20 re f".to_vec(),
    ));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Fm0" => Object::Reference(form_id) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q .5 0 0 .5 10 10 cm /Fm0 Do Q".to_vec(),
    ));
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

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let w = r.buffer.width() as usize;
    let row = (r.buffer.height() as usize / 2) * w;
    let k = r.buffer.plate_u8(3);
    let mut bands = 0;
    let mut prev = 0u8;
    for x in 10..30 {
        let v = k[row + x];
        if v > 128 && prev <= 128 {
            bands += 1;
        }
        prev = v;
    }
    assert_eq!(
        bands, 4,
        "pattern phải dùng CTM đầu form; `cm` nội bộ không được phóng bước lặp lần nữa"
    );
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
    let names: Vec<&str> = r
        .buffer
        .space()
        .colorants()
        .iter()
        .map(|c| c.name())
        .collect();
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
    // nên engine phải báo thiếu tính năng và dừng an toàn.
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

// ─────────────────────────────────────────────────────────────────────────────
//  Pattern × glyph TrueType
// ─────────────────────────────────────────────────────────────────────────────

fn bundled_truetype_font() -> Vec<u8> {
    include_bytes!("../../backend/app/assets/fonts/DejaVuSans.ttf").to_vec()
}

/// Dựng trang có một glyph TrueType dùng Pattern làm màu fill/stroke.
fn render_pattern_text_with_options(
    content: &str,
    ttf: Vec<u8>,
    include_pattern: bool,
    options: RenderOptions,
) -> PageRender {
    let mut doc = Document::with_version("1.7");

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
    let font = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "TrueType",
        "BaseFont" => "DejaVuSans",
        "Encoding" => "WinAnsiEncoding",
        "FirstChar" => 32,
        "LastChar" => 126,
        "Widths" => Object::Array((32..=126).map(|_| Object::Integer(600)).collect()),
        "FontDescriptor" => Object::Reference(descriptor),
    });

    let pattern = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 8.into(), 8.into()],
            "XStep" => 8,
            "YStep" => 8,
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 0 0 4 8 re f".to_vec(),
    ));
    let mut patterns = dictionary! {};
    if include_pattern {
        patterns.set("P0", Object::Reference(pattern));
    }
    let resources = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => Object::Reference(font) },
        "Pattern" => patterns,
        "ColorSpace" => dictionary! { "CS0" => plain_pattern_cs() },
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
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    render_page(&doc, 1, 72.0, PageBox::Crop, options).expect("render chữ Pattern phải thành công")
}

fn render_pattern_text(content: &str, ttf: Vec<u8>, include_pattern: bool) -> PageRender {
    render_pattern_text_with_options(content, ttf, include_pattern, RenderOptions::ink_accurate())
}

/// Đếm pixel có mực trong hình chữ nhật theo toạ độ PDF (gốc trái-dưới).
fn inked_pixels_in_pdf_rect(r: &PageRender, channel: usize, rect: [usize; 4]) -> usize {
    let width = r.buffer.width() as usize;
    let height = r.buffer.height() as usize;
    let x0 = rect[0].min(width);
    let x1 = rect[2].min(width);
    let y0 = height.saturating_sub(rect[3].min(height));
    let y1 = height.saturating_sub(rect[1].min(height));
    let plate = r.buffer.plate_u8(channel);

    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| y * width + x))
        .filter(|index| plate[*index] > 10)
        .count()
}

#[test]
fn tiling_pattern_fills_truetype_glyph_in_local_roi() {
    let ttf = bundled_truetype_font();
    let solid = render_pattern_text("BT /F1 28 Tf 0 0 0 1 k 5 7 Td (H) Tj ET", ttf.clone(), true);
    let r = render_pattern_text("BT /F1 28 Tf /CS0 cs /P0 scn 5 7 Td (H) Tj ET", ttf, true);
    let roi = [4, 5, 30, 34];
    let glyph_ink = inked_pixels_in_pdf_rect(&r, 3, roi);
    let solid_ink = inked_pixels_in_pdf_rect(&solid, 3, roi);
    assert!(
        glyph_ink * 100 > solid_ink * 20 && glyph_ink * 100 < solid_ink * 80,
        "ô Pattern phủ nửa bước phải cho glyph thưa hơn màu đặc: pattern={glyph_ink}, solid={solid_ink}"
    );
    assert_eq!(
        inked_pixels_in_pdf_rect(&r, 3, [32, 0, 40, 40]),
        0,
        "Pattern không được tràn khỏi glyph"
    );
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    assert!(!r.warnings.ink_unsound(), "{:?}", r.warnings);
}

#[test]
fn tiling_pattern_strokes_truetype_glyph_in_local_roi() {
    let ttf = bundled_truetype_font();
    let solid = render_pattern_text(
        "BT /F1 28 Tf 2 w 1 Tr 0 0 0 1 K 5 7 Td (H) Tj ET",
        ttf.clone(),
        true,
    );
    let r = render_pattern_text(
        "BT /F1 28 Tf 2 w 1 Tr /CS0 CS /P0 SCN 5 7 Td (H) Tj ET",
        ttf,
        true,
    );
    let roi = [3, 4, 31, 35];
    let glyph_ink = inked_pixels_in_pdf_rect(&r, 3, roi);
    let solid_ink = inked_pixels_in_pdf_rect(&solid, 3, roi);
    assert!(
        glyph_ink * 100 > solid_ink * 20 && glyph_ink * 100 < solid_ink * 80,
        "Pattern stroke nửa bước phải thưa hơn nét đặc: pattern={glyph_ink}, solid={solid_ink}"
    );
    assert_eq!(
        inked_pixels_in_pdf_rect(&r, 3, [33, 0, 40, 40]),
        0,
        "Pattern stroke không được tràn khỏi outline"
    );
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    assert!(!r.warnings.ink_unsound(), "{:?}", r.warnings);
}

#[test]
fn missing_text_pattern_is_reported_as_ink_unsound() {
    let ttf = bundled_truetype_font();
    let r = render_pattern_text(
        "BT /F1 28 Tf /CS0 cs /P_MISSING scn 5 7 Td (H) Tj ET",
        ttf,
        false,
    );
    assert_eq!(
        r.buffer.max_tac_percent(),
        0.0,
        "không được bịa màu thay Pattern"
    );
    assert_eq!(
        r.warnings.dropped_objects, 1,
        "một glyph chỉ được đếm mất một lần"
    );
    assert!(
        r.warnings.ink_unsound(),
        "kết quả thiếu glyph không được coi là sạch"
    );
    assert!(r.warnings.degrades_accuracy());
    let diagnostic = r
        .warnings
        .skipped_ops
        .iter()
        .find(|(op, _)| op.contains("P_MISSING"))
        .expect("diagnostics phải nêu đúng Pattern");
    assert_eq!(diagnostic.1, 1, "diagnostics không được đếm trùng");
}

#[test]
fn output_preview_text_filter_keeps_pattern_glyph_only_in_text_lane() {
    use print_engine::color::space::OutputPreviewFilter;

    let content = "BT /F1 28 Tf /CS0 cs /P0 scn 5 7 Td (H) Tj ET";
    let ttf = bundled_truetype_font();
    let shown = render_pattern_text_with_options(
        content,
        ttf.clone(),
        true,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::Text),
    );
    assert!(
        inked_pixels_in_pdf_rect(&shown, 3, [4, 5, 30, 34]) > 20,
        "Show=Text phải giữ glyph được tô bằng Pattern"
    );
    assert_eq!(shown.warnings.dropped_objects, 0, "{:?}", shown.warnings);

    for filter in [
        OutputPreviewFilter::Images,
        OutputPreviewFilter::LineArt,
        OutputPreviewFilter::SmoothShades,
    ] {
        let hidden = render_pattern_text_with_options(
            content,
            ttf.clone(),
            true,
            RenderOptions::softproof().with_output_preview_filter(filter),
        );
        assert_eq!(
            hidden.buffer.max_tac_percent(),
            0.0,
            "{filter:?} không được giữ host Text"
        );
        assert_eq!(
            hidden.warnings.dropped_objects, 0,
            "object bị filter không phải object bị bỏ: {:?}",
            hidden.warnings
        );
        assert!(!hidden.warnings.ink_unsound());
    }
}

#[test]
fn hidden_line_art_with_missing_pattern_does_not_raise_false_warning() {
    use print_engine::color::space::OutputPreviewFilter;

    let hidden = render_pattern_text_with_options(
        "/CS0 cs /P_MISSING scn 0 0 40 40 re f",
        bundled_truetype_font(),
        false,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::Text),
    );
    assert_eq!(hidden.buffer.max_tac_percent(), 0.0);
    assert_eq!(hidden.warnings.dropped_objects, 0, "{:?}", hidden.warnings);
    assert!(!hidden.warnings.ink_unsound());
}

#[test]
fn pattern_colourspace_without_selected_name_is_fail_loud() {
    let r = render_pattern_text(
        "BT /F1 28 Tf /CS0 cs 5 7 Td (H) Tj ET",
        bundled_truetype_font(),
        true,
    );
    assert_eq!(
        r.buffer.max_tac_percent(),
        0.0,
        "không được bịa màu mặc định"
    );
    assert_eq!(
        r.warnings.dropped_objects, 1,
        "một glyph chỉ được đếm một lần"
    );
    assert!(r.warnings.ink_unsound());
    let diagnostic = r
        .warnings
        .skipped_ops
        .iter()
        .find(|(op, _)| op.contains("chưa chọn resource"))
        .expect("phải nói rõ Pattern chưa được chọn bằng scn/SCN");
    assert_eq!(diagnostic.1, 1);
}

#[test]
fn changing_colourspace_clears_selected_pattern_for_both_text_paint_lanes() {
    // CORRECTNESS (audit 2026-08-31 §PTXT.3): tên Pattern thuộc lần chọn
    // colorspace hiện hành; `cs/CS` kế tiếp phải đưa selection về trạng thái đầu.
    let r = render_pattern_text(
        concat!(
            "/CS0 cs /P0 scn /DeviceCMYK cs 0 0 0 1 scn /CS0 cs ",
            "/CS0 CS /P0 SCN /DeviceCMYK CS 0 0 0 1 SCN /CS0 CS ",
            "BT /F1 28 Tf 2 w 2 Tr 5 7 Td (H) Tj ET"
        ),
        bundled_truetype_font(),
        true,
    );

    assert_eq!(
        r.buffer.max_tac_percent(),
        0.0,
        "không được dùng lại tên Pattern từ colorspace cũ"
    );
    assert_eq!(
        r.warnings.dropped_objects, 2,
        "fill và stroke là hai paint lane bị mất độc lập"
    );
    assert!(r.warnings.ink_unsound());
    for target in ["Pattern fill", "Pattern stroke"] {
        let diagnostic = r
            .warnings
            .skipped_ops
            .iter()
            .find(|(op, _)| op.contains(target) && op.contains("chưa chọn resource"))
            .unwrap_or_else(|| panic!("thiếu diagnostics cho {target}"));
        assert_eq!(diagnostic.1, 1, "mỗi paint lane chỉ được đếm một lần");
    }
}

#[test]
fn missing_fill_and_stroke_pattern_outside_clip_is_not_reported() {
    // Object không thể phủ pixel sau clip không phải nội dung bị mất. Resource
    // cố ý thiếu để chứng minh preflight diễn ra trước diagnostics fail-loud.
    let r = render_pattern_text(
        concat!(
            "q 35 35 4 4 re W n ",
            "/CS0 cs /P_MISSING scn /CS0 CS /P_MISSING SCN ",
            "BT /F1 28 Tf 2 w 2 Tr 5 7 Td (H) Tj ET Q"
        ),
        bundled_truetype_font(),
        false,
    );

    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "fill/stroke bị clip hết không được hạ độ tin cậy: {:?}",
        r.warnings
    );
    assert!(!r.warnings.ink_unsound(), "{:?}", r.warnings);
    assert!(
        r.warnings
            .skipped_ops
            .iter()
            .all(|(op, _)| !op.contains("P_MISSING")),
        "không được để lại warning resource cho object vô hình"
    );
}

#[test]
fn pattern_text_fill_and_stroke_share_parent_depth_at_limit() {
    let mut options = RenderOptions::ink_accurate();
    options.max_form_depth = 1;
    let fill_only = render_pattern_text_with_options(
        "BT /F1 28 Tf 4 w /CS0 cs /P0 scn 0 Tr 5 7 Td (H) Tj ET",
        bundled_truetype_font(),
        true,
        options.clone(),
    );
    let fill_ink = inked_pixels_in_pdf_rect(&fill_only, 3, [1, 2, 34, 38]);
    assert_eq!(
        fill_only.warnings.dropped_objects, 0,
        "{:?}",
        fill_only.warnings
    );

    // `Tr 2` và `Tr 6` đều paint fill rồi stroke. Cell fill không được để
    // `cur_depth` ở tầng con khiến stroke kế tiếp bị cap oan.
    for mode in [2, 6] {
        let content =
            format!("BT /F1 28 Tf 4 w /CS0 cs /P0 scn /CS0 CS /P0 SCN {mode} Tr 5 7 Td (H) Tj ET");
        let r = render_pattern_text_with_options(
            &content,
            bundled_truetype_font(),
            true,
            options.clone(),
        );
        let combined_ink = inked_pixels_in_pdf_rect(&r, 3, [1, 2, 34, 38]);

        assert!(
            combined_ink > fill_ink,
            "Tr {mode}: stroke Pattern phải thêm mực: fill={fill_ink}, combined={combined_ink}"
        );
        assert_eq!(
            r.warnings.dropped_objects, 0,
            "Tr {mode} không được nhận depth của cell fill: {:?}",
            r.warnings
        );
        assert!(!r.warnings.ink_unsound(), "Tr {mode}: {:?}", r.warnings);
    }
}

fn host_smask_tiling_pattern_document(cell_paints: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let mut malformed_image = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 8,
        "ColorSpace" => "DeviceGray",
    };
    malformed_image.set("Mask", Object::Null);
    let image_id = doc.add_object(Stream::new(malformed_image, vec![0]));
    let mask_form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
            },
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        format!("q {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q").into_bytes(),
    ));
    let pattern_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "XStep" => 10,
            "YStep" => 10,
            "Resources" => dictionary! {},
        },
        if cell_paints {
            b"0 0 0 1 k 0 0 10 10 re f".to_vec()
        } else {
            Vec::new()
        },
    ));
    let resources_id = doc.add_object(dictionary! {
        "Pattern" => dictionary! { "P0" => Object::Reference(pattern_id) },
        "ExtGState" => dictionary! {
            "GS0" => dictionary! {
                "SMask" => Object::Dictionary(dictionary! {
                    "S" => "Alpha",
                    "G" => Object::Reference(mask_form_id),
                }),
            },
        },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("/GS0 gs /Pattern cs /P0 scn 0 0 {PAGE} {PAGE} re f").into_bytes(),
    ));
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
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

#[test]
fn tiling_pattern_propagates_host_smask_event_only_after_real_cell_paint() {
    const EXPLICIT_MASK_REASON: &str = "ảnh /Mask explicit không giải mã được";

    let visible = render_page(
        &host_smask_tiling_pattern_document(true),
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
    )
    .expect("tiling Pattern có SMask phải render được");
    assert!(visible.buffer.max_tac_percent() > 99.0);
    assert!(visible.warnings.ink_unsound(), "{:?}", visible.warnings);
    assert!(
        visible
            .warnings
            .skipped_ops
            .iter()
            .any(|(reason, count)| reason == EXPLICIT_MASK_REASON && *count == 1),
        "nhiều cell chỉ được commit cùng event một lần: {:?}",
        visible.warnings.skipped_ops
    );

    let blank = render_page(
        &host_smask_tiling_pattern_document(false),
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
    )
    .expect("tiling Pattern rỗng phải render được");
    assert_eq!(blank.buffer.max_tac_percent(), 0.0);
    assert!(
        !blank
            .warnings
            .skipped_ops
            .iter()
            .any(|(reason, _)| reason == EXPLICIT_MASK_REASON),
        "cell không paint không được commit event host SMask: {:?}",
        blank.warnings.skipped_ops
    );
    assert!(!blank.warnings.ink_unsound(), "{:?}", blank.warnings);
}

fn finish_spatial_host_smask_tiling_pattern_document(
    mut doc: Document,
    page: i64,
    event_width: i64,
    valid_x: i64,
    cell: Vec<u8>,
    cell_resources: lopdf::Dictionary,
) -> Document {
    let mut malformed_image = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 8,
        "ColorSpace" => "DeviceGray",
    };
    malformed_image.set("Mask", Object::Null);
    let image_id = doc.add_object(Stream::new(malformed_image, vec![0]));
    let mask_form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), page.into(), page.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
            },
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        // Event ở dải trái; object hợp lệ tạo alpha độc lập ở dải phải.
        format!(
            "q {event_width} 0 0 {page} 0 0 cm /Im0 Do Q 0 g {valid_x} 0 {event_width} {page} re f"
        )
        .into_bytes(),
    ));
    let pattern_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), page.into(), page.into()],
            "XStep" => page,
            "YStep" => page,
            "Resources" => Object::Dictionary(cell_resources),
        },
        cell,
    ));
    let resources_id = doc.add_object(dictionary! {
        "Pattern" => dictionary! { "P0" => Object::Reference(pattern_id) },
        "ExtGState" => dictionary! {
            "GS0" => dictionary! {
                "SMask" => Object::Dictionary(dictionary! {
                    "S" => "Alpha",
                    "G" => Object::Reference(mask_form_id),
                }),
            },
        },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("/GS0 gs /Pattern cs /P0 scn 0 0 {page} {page} re f").into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), page.into(), page.into()],
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

fn spatial_host_smask_tiling_pattern_document(cell_overlaps_event: bool) -> Document {
    let x = if cell_overlaps_event { 0 } else { 30 };
    finish_spatial_host_smask_tiling_pattern_document(
        Document::with_version("1.7"),
        PAGE,
        10,
        30,
        format!("0 0 0 1 k {x} 0 10 {PAGE} re f").into_bytes(),
        dictionary! {},
    )
}

fn explicit_mask_warning_count(warnings: &print_engine::RenderWarnings) -> u32 {
    const EXPLICIT_MASK_REASON: &str = "ảnh /Mask explicit không giải mã được";
    warnings
        .skipped_ops
        .iter()
        .find(|(reason, _)| reason == EXPLICIT_MASK_REASON)
        .map_or(0, |(_, count)| *count)
}

fn assert_spatial_host_smask_result(rendered: &PageRender, expected_warnings: u32, label: &str) {
    assert!(
        rendered.buffer.max_tac_percent() > 99.0,
        "{label}: sink hợp lệ phải thật sự lên mực"
    );
    assert_eq!(
        explicit_mask_warning_count(&rendered.warnings),
        expected_warnings,
        "{label}: {:?}",
        rendered.warnings
    );
    assert_eq!(
        rendered.warnings.ink_unsound(),
        expected_warnings > 0,
        "{label}: {:?}",
        rendered.warnings
    );
}

fn render_spatial_host_smask(doc: &Document, label: &str) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .unwrap_or_else(|error| panic!("{label}: tiling Pattern spatial phải render được: {error}"))
}

#[test]
fn tiling_pattern_filters_host_smask_event_by_real_cell_footprint() {
    let disjoint_doc = spatial_host_smask_tiling_pattern_document(false);
    let disjoint = render_spatial_host_smask(&disjoint_doc, "rectangle rời event");
    assert_spatial_host_smask_result(&disjoint, 0, "rectangle rời event");

    let overlapping_doc = spatial_host_smask_tiling_pattern_document(true);
    let overlapping = render_spatial_host_smask(&overlapping_doc, "rectangle giao event");
    assert_spatial_host_smask_result(&overlapping, 1, "rectangle giao event");
}

fn axial_shading_cell_document(cell_overlaps_event: bool, page: i64) -> Document {
    let event_width = if page >= 800 { 100 } else { 10 };
    let valid_x = page - event_width;
    let shading_x = if cell_overlaps_event { 0 } else { valid_x };
    let function = dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 1.into()],
        "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
        "N" => 1,
    };
    let shading = dictionary! {
        "ShadingType" => 2,
        "ColorSpace" => "DeviceCMYK",
        "Coords" => vec![
            shading_x.into(),
            0.into(),
            (shading_x + event_width).into(),
            0.into(),
        ],
        "Function" => Object::Dictionary(function),
        "Extend" => vec![Object::Boolean(false), Object::Boolean(false)],
    };
    finish_spatial_host_smask_tiling_pattern_document(
        Document::with_version("1.7"),
        page,
        event_width,
        valid_x,
        b"/S0 sh".to_vec(),
        dictionary! {
            "Shading" => dictionary! { "S0" => Object::Dictionary(shading) },
        },
    )
}

#[test]
fn partial_axial_shading_tracks_exact_footprint_in_scalar_and_parallel_paths() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A05): axial không `/Extend` chỉ paint
    // đoạn trục thật. Bbox clip toàn trang không được kéo event host SMask ở xa.
    for overlaps in [false, true] {
        let label = if overlaps {
            "axial tuần tự giao event"
        } else {
            "axial tuần tự rời event"
        };
        let doc = axial_shading_cell_document(overlaps, PAGE);
        let rendered = render_spatial_host_smask(&doc, label);
        assert_spatial_host_smask_result(&rendered, u32::from(overlaps), label);
    }

    // 800² vượt ngưỡng 512K của compositor; pool riêng khóa đúng đường atomic bbox.
    let pool = ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .expect("phải dựng được pool test shading song song");
    for overlaps in [false, true] {
        let label = if overlaps {
            "axial song song giao event"
        } else {
            "axial song song rời event"
        };
        let doc = axial_shading_cell_document(overlaps, 800);
        let rendered = pool.install(|| render_spatial_host_smask(&doc, label));
        assert_spatial_host_smask_result(&rendered, u32::from(overlaps), label);
    }
}

fn mesh_q(value: i64, page: i64) -> u8 {
    ((value as f64 / page as f64) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8
}

fn mesh_vertex(flag: u8, x: i64, y: i64, page: i64) -> Vec<u8> {
    // Cờ + x + y + DeviceCMYK; K=1 ở cả bốn đỉnh.
    vec![flag, mesh_q(x, page), mesh_q(y, page), 0, 0, 0, 255]
}

fn mesh_shading_cell_document(cell_overlaps_event: bool) -> Document {
    let x0 = if cell_overlaps_event { 0 } else { 30 };
    let x1 = x0 + 10;
    let mut data = Vec::new();
    data.extend(mesh_vertex(0, x0, 0, PAGE));
    data.extend(mesh_vertex(0, x1, 0, PAGE));
    data.extend(mesh_vertex(0, x0, PAGE, PAGE));
    data.extend(mesh_vertex(1, x1, PAGE, PAGE));
    let mut doc = Document::with_version("1.7");
    let shading_id = doc.add_object(Stream::new(
        dictionary! {
            "ShadingType" => 4,
            "ColorSpace" => "DeviceCMYK",
            "BitsPerCoordinate" => 8,
            "BitsPerComponent" => 8,
            "BitsPerFlag" => 8,
            "Decode" => vec![
                0.into(), PAGE.into(), 0.into(), PAGE.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
            ],
        },
        data,
    ));
    finish_spatial_host_smask_tiling_pattern_document(
        doc,
        PAGE,
        10,
        30,
        b"/S0 sh".to_vec(),
        dictionary! {
            "Shading" => dictionary! { "S0" => Object::Reference(shading_id) },
        },
    )
}

#[test]
fn mesh_shading_tracks_only_triangle_pixels_in_outer_tiling_tracker() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A05): mesh dùng bbox tam giác thật,
    // không dùng bbox clip của ô tiling khi lọc provenance host SMask.
    for overlaps in [false, true] {
        let label = if overlaps {
            "mesh giao event"
        } else {
            "mesh rời event"
        };
        let doc = mesh_shading_cell_document(overlaps);
        let rendered = render_spatial_host_smask(&doc, label);
        assert_spatial_host_smask_result(&rendered, u32::from(overlaps), label);
    }
}

fn ordinary_smask_group_cell_document(mask_opens_event: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let group_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "Resources" => dictionary! {},
            "Group" => dictionary! {
                "S" => "Transparency",
                "CS" => "DeviceCMYK",
                "I" => Object::Boolean(true),
            },
        },
        format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f").into_bytes(),
    ));
    let mask_x = if mask_opens_event { 0 } else { 30 };
    let mask_form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "Resources" => dictionary! {},
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        format!("0 g {mask_x} 0 10 {PAGE} re f").into_bytes(),
    ));
    finish_spatial_host_smask_tiling_pattern_document(
        doc,
        PAGE,
        10,
        30,
        b"/GSInner gs /F0 Do".to_vec(),
        dictionary! {
            "XObject" => dictionary! { "F0" => Object::Reference(group_id) },
            "ExtGState" => dictionary! {
                "GSInner" => dictionary! {
                    "SMask" => Object::Dictionary(dictionary! {
                        "S" => "Alpha",
                        "G" => Object::Reference(mask_form_id),
                    }),
                },
            },
        },
    )
}

#[test]
fn ordinary_group_smask_returns_exact_footprint_to_outer_tiling_tracker() {
    // SMask trong group này hoàn toàn hợp lệ và không mang event riêng. Exact mode
    // phải đến từ tracker tổ tiên, nếu không group sẽ trả child bbox toàn trang.
    for overlaps in [false, true] {
        let label = if overlaps {
            "group SMask thường giao event host"
        } else {
            "group SMask thường rời event host"
        };
        let doc = ordinary_smask_group_cell_document(overlaps);
        let rendered = render_spatial_host_smask(&doc, label);
        assert_spatial_host_smask_result(&rendered, u32::from(overlaps), label);
    }
}

fn nested_tiling_cell_document(inner_overlaps_event: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let inner_x = if inner_overlaps_event { 0 } else { 30 };
    let inner_pattern_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            "XStep" => PAGE,
            "YStep" => PAGE,
            "Resources" => dictionary! {},
        },
        format!("0 0 0 1 k {inner_x} 0 10 {PAGE} re f").into_bytes(),
    ));
    finish_spatial_host_smask_tiling_pattern_document(
        doc,
        PAGE,
        10,
        30,
        format!("/Pattern cs /P1 scn 0 0 {PAGE} {PAGE} re f").into_bytes(),
        dictionary! {
            "Pattern" => dictionary! { "P1" => Object::Reference(inner_pattern_id) },
        },
    )
}

#[test]
fn nested_tiling_tracker_merges_only_after_inner_operation_succeeds() {
    // Tracker inner phải merge footprint lên tracker outer, không commit thẳng ra
    // surface; outer mới lọc event host SMask sau khi toàn bộ operation thành công.
    for overlaps in [false, true] {
        let label = if overlaps {
            "tiling lồng giao event"
        } else {
            "tiling lồng rời event"
        };
        let doc = nested_tiling_cell_document(overlaps);
        let rendered = render_spatial_host_smask(&doc, label);
        assert_spatial_host_smask_result(&rendered, u32::from(overlaps), label);
    }
}

fn rollback_tiling_resources() -> (Document, lopdf::Dictionary) {
    let mut doc = Document::with_version("1.7");
    let mut malformed_image = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 8,
        "ColorSpace" => "DeviceGray",
    };
    malformed_image.set("Mask", Object::Null);
    let malformed_id = doc.add_object(Stream::new(malformed_image, vec![0]));
    let host_mask_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Bad" => Object::Reference(malformed_id) },
            },
            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
        },
        // Event ở trái; alpha hợp lệ độc lập ở phải giữ host SMask có vùng dùng được.
        b"q 2 0 0 10 0 0 cm /Bad Do Q 0 g 8 0 2 10 re f".to_vec(),
    ));

    let tint_function = dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
        "N" => 1,
    };
    let failing_group_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => dictionary! {
                "ColorSpace" => dictionary! {
                    "Spot" => vec![
                        Object::Name(b"Separation".to_vec()),
                        Object::Name(b"Late".to_vec()),
                        Object::Name(b"DeviceCMYK".to_vec()),
                        Object::Dictionary(tint_function),
                    ],
                },
            },
            "Group" => dictionary! {
                "S" => "Transparency",
                "CS" => "DeviceCMYK",
                "I" => Object::Boolean(true),
            },
        },
        // Child buffer vừa đủ cấp; kẽm spot muộn làm operation lỗi sau rectangle trước đó.
        b"/Spot cs 1 scn 0 0 10 10 re f".to_vec(),
    ));
    let failing_pattern_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "XStep" => 10,
            "YStep" => 10,
            "Resources" => dictionary! {
                "XObject" => dictionary! {
                    "BadDirect" => Object::Reference(malformed_id),
                    "F0" => Object::Reference(failing_group_id),
                },
            },
        },
        // Direct event đã paint trước khi group xin kẽm spot và làm operation lỗi.
        b"q 2 0 0 10 0 0 cm /BadDirect Do Q /F0 Do".to_vec(),
    ));
    let good_pattern_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "XStep" => 10,
            "YStep" => 10,
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 0 0 2 10 re f".to_vec(),
    ));
    let resources = dictionary! {
        "Pattern" => dictionary! {
            "PFail" => Object::Reference(failing_pattern_id),
            "PGood" => Object::Reference(good_pattern_id),
        },
        "ExtGState" => dictionary! {
            "GS0" => dictionary! {
                "SMask" => Object::Dictionary(dictionary! {
                    "S" => "Alpha",
                    "G" => Object::Reference(host_mask_id),
                }),
            },
        },
    };
    (doc, resources)
}

#[test]
fn failed_tiling_operation_discards_footprint_and_restores_nested_tracker() {
    // CORRECTNESS (audit 2026-08-31 §PPE-A05): lỗi tài nguyên xảy ra sau image
    // `/Mask` hỏng đã paint không được commit direct event hay host-SMask event;
    // lần chạy xanh kế tiếp còn chứng minh transaction cũ đã pop hoàn toàn.
    const BUDGET: usize = 5_250;
    let (doc, resources) = rollback_tiling_resources();
    let buffer = print_engine::InkBuffer::new_with_memory_budget(
        10,
        10,
        print_engine::InkSpace::new(),
        BUDGET,
    )
    .expect("buffer gốc phải vừa ngân sách test");
    let mut renderer = print_engine::Renderer::new(
        &doc,
        buffer,
        RenderOptions::ink_accurate().with_memory_budget_bytes(BUDGET),
        None,
        print_engine::content::BlendSpace::DeviceCmyk,
    )
    .expect("renderer phải vừa ngân sách test");

    let failed = renderer.run(
        b"/GS0 gs /Pattern cs /PFail scn 0 0 10 10 re f",
        Some(&resources),
        print_engine::geom::Matrix::IDENTITY,
    );
    assert!(
        matches!(
            &failed,
            Err(print_engine::PpeError::MemoryBudgetExceeded { .. })
        ),
        "operation phải lỗi đúng tại kẽm spot muộn: {failed:?}"
    );
    assert_eq!(
        explicit_mask_warning_count(renderer.warnings()),
        0,
        "operation lỗi không được commit event host SMask: {:?}",
        renderer.warnings()
    );

    renderer
        .run(
            b"/GS0 gs /Pattern cs /PGood scn 0 0 10 10 re f",
            Some(&resources),
            print_engine::geom::Matrix::IDENTITY,
        )
        .expect("operation sau lỗi phải render được");
    assert_eq!(
        explicit_mask_warning_count(renderer.warnings()),
        1,
        "tracker mồ côi không được nuốt event của operation xanh kế tiếp: {:?}",
        renderer.warnings()
    );
}
