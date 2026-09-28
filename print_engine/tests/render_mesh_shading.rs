//! Test tích hợp shading lưới — kiểu 4/5 (tam giác Gouraud) và 6/7 (Coons/tensor).
//!
//! Đây là dạng gradient mà Illustrator xuất cho mọi hiệu ứng chuyển màu tự do. Chúng
//! luôn phủ diện tích lớn, nên nếu engine bỏ chúng thì lượng mực bị báo **thiếu**
//! đúng ở chỗ dễ vượt ngưỡng nhất.
//!
//! Test ở đây chốt ba thứ: mực có lên đúng vùng của lưới, màu có nội suy giữa các
//! đỉnh, và cơ chế nối cạnh (cờ 1/2/3 của kiểu 6/7) có đặt patch đúng chỗ — nếu sai,
//! lưới rời thành các mảnh và diện tích phủ hụt.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{
    render_page, render_page_managed_region, PageBox, PageRender, RasterClip,
};
use print_engine::PpeError;

const PAGE: f32 = 40.0;

/// Lượng hoá toạ độ về byte theo `/Decode [0 40 0 40]`.
fn q(v: f32) -> u8 {
    (v / PAGE * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Dựng trang tô một shading lưới bằng `sh`.
fn render_mesh(shading_type: i64, extra: Dictionary, data: Vec<u8>) -> PageRender {
    let doc = mesh_document(shading_type, extra, data, "/Sh0 sh", dictionary! {});
    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn mesh_document(
    shading_type: i64,
    extra: Dictionary,
    data: Vec<u8>,
    content: &str,
    mut resources: Dictionary,
) -> Document {
    let mut dict = dictionary! {
        "ShadingType" => shading_type,
        "ColorSpace" => "DeviceGray",
        "BitsPerCoordinate" => 8,
        "BitsPerComponent" => 8,
        "BitsPerFlag" => 8,
        "Decode" => vec![
            0.into(), 40.into(), 0.into(), 40.into(), 0.into(), 1.into(),
        ],
    };
    for (k, v) in extra.iter() {
        dict.set(k.to_vec(), v.clone());
    }

    let mut doc = Document::with_version("1.7");
    let shading = doc.add_object(Stream::new(dict, data));
    resources.set(
        "Shading",
        dictionary! { "Sh0" => Object::Reference(shading) },
    );
    let resources = doc.add_object(resources);
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog));

    doc
}

fn px(r: &PageRender, channel: usize, x: usize, y: usize) -> u8 {
    r.buffer.plate_u8(channel)[y * r.buffer.width() as usize + x]
}

/// Một đỉnh kiểu 4: cờ + x + y + một kênh xám.
fn v4(flag: u8, x: f32, y: f32, gray: u8) -> [u8; 4] {
    [flag, q(x), q(y), gray]
}

/// Chu vi của hình chữ nhật `[x0,x1] × [y0,y1]` theo thứ tự 12 điểm của kiểu 6.
///
/// Đi từ góc `(x0,y0)` sang phải theo cạnh dưới, lên cạnh phải, về theo cạnh trên,
/// rồi xuống cạnh trái. Đây chính là thứ tự mà spec quy định cho `p1…p12`.
fn coons_rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<u8> {
    let tx = |t: f32| x0 + (x1 - x0) * t;
    let ty = |t: f32| y0 + (y1 - y0) * t;
    let pts = [
        (tx(0.0), ty(0.0)),
        (tx(1.0 / 3.0), ty(0.0)),
        (tx(2.0 / 3.0), ty(0.0)),
        (tx(1.0), ty(0.0)),
        (tx(1.0), ty(1.0 / 3.0)),
        (tx(1.0), ty(2.0 / 3.0)),
        (tx(1.0), ty(1.0)),
        (tx(2.0 / 3.0), ty(1.0)),
        (tx(1.0 / 3.0), ty(1.0)),
        (tx(0.0), ty(1.0)),
        (tx(0.0), ty(2.0 / 3.0)),
        (tx(0.0), ty(1.0 / 3.0)),
    ];
    pts.iter().flat_map(|(x, y)| [q(*x), q(*y)]).collect()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kiểu 4 — lưới tam giác tự do
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn free_form_triangle_paints_only_inside_itself() {
    // Tam giác (0,0)-(40,0)-(0,40) phủ nửa dưới-trái của trang PDF.
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 0));
    data.extend(v4(0, PAGE, 0.0, 0));
    data.extend(v4(0, 0.0, PAGE, 0));
    let r = render_mesh(4, dictionary! {}, data);
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    // PDF (0,0) là góc dưới-trái ⇒ hàng cuối của raster.
    assert_eq!(px(&r, 3, 2, h - 3), 255, "trong tam giác phải có mực");
    assert_eq!(px(&r, 3, w - 3, 2), 0, "ngoài tam giác phải trắng");
}

#[test]
fn gouraud_colour_is_interpolated_between_vertices() {
    // Hai đỉnh đen (gray 0 ⇒ K 100%), một đỉnh trắng. Điểm giữa cạnh đen–trắng phải
    // ra khoảng nửa mực. Nếu lấy màu một đỉnh cho cả tam giác thì test này đỏ.
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 0)); // đen
    data.extend(v4(0, PAGE, 0.0, 0)); // đen
    data.extend(v4(0, 0.0, PAGE, 255)); // trắng
    let r = render_mesh(4, dictionary! {}, data);
    let h = r.buffer.height() as usize;
    let bottom = px(&r, 3, 2, h - 3);
    let middle = px(&r, 3, 2, h / 2);
    // Hàng đo cách đáy ~2.5pt trên 40pt ⇒ đỉnh trắng đã góp ~6% ⇒ 239, không phải 255.
    assert!(bottom > 230, "đáy phải gần đặc: {bottom}");
    assert!(
        (middle as i32 - 128).abs() < 40,
        "giữa phải ~50% mực: {middle}"
    );
}

#[test]
fn flag_one_continues_the_strip() {
    // Hai tam giác nối thành hình chữ nhật phủ kín trang. Nếu cờ 1 bị bỏ, chỉ có nửa
    // trang lên mực và lượng mực bị báo thiếu.
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 0));
    data.extend(v4(0, PAGE, 0.0, 0));
    data.extend(v4(0, 0.0, PAGE, 0));
    data.extend(v4(1, PAGE, PAGE, 0));
    let r = render_mesh(4, dictionary! {}, data);
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    assert_eq!(px(&r, 3, 2, h - 3), 255);
    assert_eq!(
        px(&r, 3, w - 3, 2),
        255,
        "tam giác thứ hai phải phủ góc kia"
    );
    let cov = r.buffer.plate_coverage_pct(3);
    assert!(cov > 95.0, "phải phủ gần kín trang: {cov}");
}

#[test]
fn cmyk_mesh_reaches_full_ink_on_every_channel() {
    // Lưới trong DeviceCMYK: mực là mực, không qua ICC ⇒ vùng đặc phải đọc 400%.
    let extra = dictionary! {
        "ColorSpace" => "DeviceCMYK",
        "Decode" => vec![
            0.into(), 40.into(), 0.into(), 40.into(),
            0.into(), 1.into(), 0.into(), 1.into(), 0.into(), 1.into(), 0.into(), 1.into(),
        ],
    };
    let vertex =
        |flag: u8, x: f32, y: f32| -> Vec<u8> { vec![flag, q(x), q(y), 255, 255, 255, 255] };
    let mut data = Vec::new();
    data.extend(vertex(0, 0.0, 0.0));
    data.extend(vertex(0, PAGE, 0.0));
    data.extend(vertex(0, 0.0, PAGE));
    data.extend(vertex(1, PAGE, PAGE));
    let r = render_mesh(4, extra, data);
    assert!(
        (r.buffer.max_tac_percent() - 400.0).abs() < 1.0,
        "TAC={}",
        r.buffer.max_tac_percent()
    );
}

#[test]
fn mesh_with_function_maps_a_single_parameter() {
    // Đỉnh mang một tham số `t`; hàm biến nó thành CMYK. Đây là dạng mà một lưới
    // nhiều kênh được nén xuống một kênh trong file.
    let extra = dictionary! {
        "ColorSpace" => "DeviceCMYK",
        "Decode" => vec![0.into(), 40.into(), 0.into(), 40.into(), 0.into(), 1.into()],
        "Function" => Object::Dictionary(dictionary! {
            "FunctionType" => 2,
            "Domain" => vec![0.into(), 1.into()],
            "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
            "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
            "N" => 1,
            "Range" => vec![
                0.into(), 1.into(), 0.into(), 1.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
            ],
        }),
    };
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 255)); // t = 1 ⇒ K 100%
    data.extend(v4(0, PAGE, 0.0, 255));
    data.extend(v4(0, 0.0, PAGE, 255));
    data.extend(v4(1, PAGE, PAGE, 255));
    let r = render_mesh(4, extra, data);
    assert!(
        (r.buffer.max_tac_percent() - 100.0).abs() < 1.0,
        "TAC={}",
        r.buffer.max_tac_percent()
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kiểu 5 — lưới hình chữ nhật
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn lattice_mesh_covers_the_page() {
    // Kiểu 5 KHÔNG có cờ và KHÔNG đệm theo đỉnh; đọc sai bố cục là lệch ngay từ đỉnh
    // thứ hai và lưới ra sai chỗ.
    let vertex = |x: f32, y: f32| -> [u8; 3] { [q(x), q(y), 0] };
    let mut data = Vec::new();
    data.extend(vertex(0.0, 0.0));
    data.extend(vertex(PAGE, 0.0));
    data.extend(vertex(0.0, PAGE));
    data.extend(vertex(PAGE, PAGE));
    let r = render_mesh(5, dictionary! { "VerticesPerRow" => 2 }, data);
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    let cov = r.buffer.plate_coverage_pct(3);
    assert!(cov > 95.0, "phải phủ gần kín trang: {cov}");
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
}

#[test]
fn lattice_mesh_interpolates_across_the_row() {
    let vertex = |x: f32, y: f32, g: u8| -> [u8; 3] { [q(x), q(y), g] };
    let mut data = Vec::new();
    data.extend(vertex(0.0, 0.0, 0)); // đen
    data.extend(vertex(PAGE, 0.0, 255)); // trắng
    data.extend(vertex(0.0, PAGE, 0));
    data.extend(vertex(PAGE, PAGE, 255));
    let r = render_mesh(5, dictionary! { "VerticesPerRow" => 2 }, data);
    let w = r.buffer.width() as usize;
    let y = r.buffer.height() as usize / 2;
    assert!(px(&r, 3, 1, y) > 240, "trái phải đặc");
    assert!(px(&r, 3, w - 2, y) < 20, "phải phải trắng");
    let mid = px(&r, 3, w / 2, y);
    assert!((mid as i32 - 128).abs() < 40, "giữa phải ~50%: {mid}");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kiểu 6/7 — Coons và tensor patch
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn coons_patch_covers_its_rectangle() {
    let mut data = vec![0u8]; // cờ 0
    data.extend(coons_rect(0.0, 0.0, PAGE, PAGE));
    data.extend_from_slice(&[0, 0, 0, 0]); // bốn góc đen
    let r = render_mesh(6, dictionary! {}, data);
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    let cov = r.buffer.plate_coverage_pct(3);
    assert!(cov > 90.0, "patch phải phủ gần kín trang: {cov}");
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
}

#[test]
fn coons_patch_interpolates_corner_colours() {
    // Hai góc bên trái đen, hai góc bên phải trắng.
    let mut data = vec![0u8];
    data.extend(coons_rect(0.0, 0.0, PAGE, PAGE));
    // c1 tại (0,0), c2 tại (40,0), c3 tại (40,40), c4 tại (0,40).
    data.extend_from_slice(&[0, 255, 255, 0]);
    let r = render_mesh(6, dictionary! {}, data);
    let w = r.buffer.width() as usize;
    let y = r.buffer.height() as usize / 2;
    assert!(px(&r, 3, 1, y) > 200, "cạnh trái phải đậm");
    assert!(px(&r, 3, w - 2, y) < 60, "cạnh phải phải nhạt");
}

#[test]
fn tensor_patch_covers_its_rectangle() {
    let mut data = vec![0u8];
    data.extend(coons_rect(0.0, 0.0, PAGE, PAGE));
    // Bốn điểm trong theo Table86: p11, p12, p22, p21 của lưới 4×4.
    for (x, y) in [
        (PAGE / 3.0, PAGE / 3.0),
        (PAGE * 2.0 / 3.0, PAGE / 3.0),
        (PAGE * 2.0 / 3.0, PAGE * 2.0 / 3.0),
        (PAGE / 3.0, PAGE * 2.0 / 3.0),
    ] {
        data.push(q(x));
        data.push(q(y));
    }
    data.extend_from_slice(&[0, 0, 0, 0]);
    let r = render_mesh(7, dictionary! {}, data);
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "{:?}",
        r.warnings.skipped_ops
    );
    let cov = r.buffer.plate_coverage_pct(3);
    assert!(cov > 90.0, "tensor patch phải phủ gần kín trang: {cov}");
}

#[test]
fn patch_edge_flag_joins_two_patches_without_a_gap() {
    // Patch 1 phủ nửa trái; patch 2 dùng cờ 1 để nối cạnh và phủ nửa phải. Nếu cơ chế
    // nối cạnh sai, hai patch rời nhau và giữa trang có vệt trắng — báo thiếu mực.
    let half = PAGE / 2.0;
    let mut data = vec![0u8];
    data.extend(coons_rect(0.0, 0.0, half, PAGE));
    data.extend_from_slice(&[0, 0, 0, 0]);

    // Patch 2, cờ 1: p1..p4 = cạnh (half,0)…(half,40) của patch trước.
    data.push(1);
    // p5..p7: từ p4 = (half,40) đi sang phải theo cạnh trên.
    let along = |t: f32| (half + (PAGE - half) * t, PAGE);
    let back = |t: f32| (PAGE, PAGE * (1.0 - t));
    let up = |t: f32| (half + (PAGE - half) * (1.0 - t), 0.0);
    for (x, y) in [
        along(1.0 / 3.0),
        along(2.0 / 3.0),
        along(1.0),
        back(1.0 / 3.0),
        back(2.0 / 3.0),
        back(1.0),
        up(1.0 / 3.0),
        up(2.0 / 3.0),
    ] {
        data.push(q(x));
        data.push(q(y));
    }
    data.extend_from_slice(&[0, 0]); // hai màu còn lại

    let r = render_mesh(6, dictionary! {}, data);
    let w = r.buffer.width() as usize;
    let y = r.buffer.height() as usize / 2;
    assert!(px(&r, 3, 2, y) > 200, "nửa trái phải có mực");
    assert!(px(&r, 3, w - 3, y) > 200, "nửa phải phải có mực");
    assert!(
        px(&r, 3, w / 2, y) > 200,
        "chỗ nối không được có vệt trắng: {}",
        px(&r, 3, w / 2, y)
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Spot, clip và file hỏng
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn spot_colour_mesh_gets_its_own_plate() {
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
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 255));
    data.extend(v4(0, PAGE, 0.0, 255));
    data.extend(v4(0, 0.0, PAGE, 255));
    data.extend(v4(1, PAGE, PAGE, 255));
    let r = render_mesh(4, dictionary! { "ColorSpace" => sep }, data);
    let names: Vec<&str> = r
        .buffer
        .space()
        .colorants()
        .iter()
        .map(|c| c.name())
        .collect();
    assert!(names.contains(&"PANTONE 485 C"), "{names:?}");
    let idx = r
        .buffer
        .space()
        .colorants()
        .iter()
        .position(|c| c.name() == "PANTONE 485 C")
        .unwrap();
    assert_eq!(px(&r, idx, 2, 2), 255, "spot phải đặc");
}

#[test]
fn mesh_is_limited_by_the_clip() {
    // `sh` tô theo **vùng clip**. Nhầm sang đường dẫn làm lưới tràn ra ngoài.
    let mut doc = Document::with_version("1.7");
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 0));
    data.extend(v4(0, PAGE, 0.0, 0));
    data.extend(v4(0, 0.0, PAGE, 0));
    data.extend(v4(1, PAGE, PAGE, 0));
    let shading = doc.add_object(Stream::new(
        dictionary! {
            "ShadingType" => 4,
            "ColorSpace" => "DeviceGray",
            "BitsPerCoordinate" => 8,
            "BitsPerComponent" => 8,
            "BitsPerFlag" => 8,
            "Decode" => vec![0.into(), 40.into(), 0.into(), 40.into(), 0.into(), 1.into()],
        },
        data,
    ));
    let resources = doc.add_object(dictionary! {
        "Shading" => dictionary! { "Sh0" => Object::Reference(shading) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 0 0 20 40 re W n /Sh0 sh Q".to_vec(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources),
        "MediaBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
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
    let w = r.buffer.width() as usize;
    let y = r.buffer.height() as usize / 2;
    assert_eq!(px(&r, 3, 2, y), 255, "trong clip phải có mực");
    assert_eq!(px(&r, 3, w - 3, y), 0, "ngoài clip phải trắng");
}

#[test]
fn mesh_without_decode_is_reported_not_silently_blank() {
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 0));
    data.extend(v4(0, PAGE, 0.0, 0));
    data.extend(v4(0, 0.0, PAGE, 0));
    // Ghi đè `/Decode` bằng mảng quá ngắn.
    let r = render_mesh(
        4,
        dictionary! { "Decode" => vec![0.into(), 40.into()] },
        data,
    );
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert!(r.warnings.dropped_objects > 0, "phải báo lỗi cấu trúc");
    assert!(r.warnings.ink_unsound());
}

#[test]
fn empty_mesh_stream_is_reported() {
    let r = render_mesh(4, dictionary! {}, Vec::new());
    assert!(r.warnings.dropped_objects > 0);
    assert!(r.warnings.ink_unsound());
}

#[test]
fn c2c_mesh_is_one_object_at_a_shared_triangle_edge() {
    // QUALITY (audit 2026-09-28 §KNOCK.C2c): /sh là MỘT object. Hai tam
    // giác chỉ chia hình học, không được áp ca=.5 hai lần tại cạnh chung.
    let mut data = Vec::new();
    data.extend(v4(0, 0.0, 0.0, 0));
    data.extend(v4(0, PAGE, 0.0, 0));
    data.extend(v4(0, 0.0, PAGE, 0));
    data.extend(v4(1, PAGE, PAGE, 0));
    let doc = mesh_document(
        4,
        dictionary! {},
        data,
        "/A gs /Sh0 sh",
        dictionary! { "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5 } } },
    );
    let page = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    for (x, y) in [(8, 8), (20, 20), (31, 31)] {
        let actual = page.buffer.plane(3)[y * page.buffer.width() as usize + x];
        assert!(
            (actual - 0.5).abs() < 2e-6,
            "Cạnh chung ({x},{y}) chỉ composite một lần: K phải=.5, nhận{actual}"
        );
    }
}

fn tensor_rect() -> Vec<u8> {
    let mut points = coons_rect(0.0, 0.0, PAGE, PAGE);
    for (x, y) in [
        (PAGE / 3.0, PAGE / 3.0),
        (PAGE * 2.0 / 3.0, PAGE / 3.0),
        (PAGE * 2.0 / 3.0, PAGE * 2.0 / 3.0),
        (PAGE / 3.0, PAGE * 2.0 / 3.0),
    ] {
        points.extend([q(x), q(y)]);
    }
    points
}

fn assert_float_ink(
    page: &PageRender,
    x: usize,
    y: usize,
    expected: [f32; 4],
    tolerance: f32,
    context: &str,
) {
    let index = y * page.buffer.width() as usize + x;
    for (channel, expected) in expected.into_iter().enumerate() {
        let actual = page.buffer.plane(channel)[index];
        assert!(
            (actual - expected).abs() <= tolerance,
            "{context}: kênh{channel} tại({x},{y}) muốn{expected}, nhận{actual}"
        );
    }
}

fn black_function(exponent: i64) -> Object {
    Object::Dictionary(dictionary! {
        "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()], "N" => exponent,
    })
}

#[test]
fn c2c_nonlinear_function_is_evaluated_after_interpolating_the_parameter() {
    for shading_type in [4, 5, 6, 7] {
        let mut extra = dictionary! {
            "ColorSpace" => "DeviceCMYK", "Function" => black_function(2),
        };
        let data = match shading_type {
            4 => [v4(0, 0., 0., 0), v4(0, PAGE, 0., 255), v4(0, 0., PAGE, 0)].concat(),
            5 => {
                extra.set("VerticesPerRow", 2);
                vec![0, 0, 0, 255, 0, 255, 0, 255, 0, 255, 255, 255]
            }
            6 | 7 => {
                let mut data = vec![0];
                data.extend(if shading_type == 6 {
                    coons_rect(0., 0., PAGE, PAGE)
                } else {
                    tensor_rect()
                });
                data.extend([0, 255, 255, 0]);
                data
            }
            _ => unreachable!(),
        };
        let page = render_mesh(shading_type, extra, data);
        // Tại PDF(10.5,19.5), t=x/40. F(t)=t², không phải nội suy F(0),F(1).
        let t: f32 = 10.5 / PAGE;
        assert_float_ink(
            &page,
            10,
            20,
            [0., 0., 0., t * t],
            1e-4,
            &format!("Shading{shading_type}: Function sau nội suy t"),
        );
        assert_eq!(page.warnings.dropped_objects, 0, "{:?}", page.warnings);
    }
}

#[test]
fn c2c_patch_colour_keeps_the_bilinear_cross_term_inside_a_triangle() {
    for shading_type in [6, 7] {
        let mut data = vec![0];
        data.extend(if shading_type == 6 {
            coons_rect(0., 0., PAGE, PAGE)
        } else {
            tensor_rect()
        });
        data.extend([0, 0, 255, 0]);
        let page = render_mesh(shading_type, dictionary! {}, data);
        // Gray=u*v có hạng chéo; nội suy tuyến tính màu của 3 đỉnh tam giác
        // nhỏ không bằng song tuyến ở UV thật dù cả bốn góc đều đúng.
        let (u, v) = (9.5 / PAGE, 23.5 / PAGE);
        assert_float_ink(
            &page,
            9,
            16,
            [0., 0., 0., 1. - u * v],
            1e-4,
            "Không làm mất hạng u*v của màu patch",
        );
    }
}

#[test]
fn c2c_tensor_control_points_keep_off_diagonal_geometry_unwarped() {
    let mut data = vec![0];
    data.extend(tensor_rect());
    data.extend([0, 255, 255, 0]);
    let page = render_mesh(7, dictionary! {}, data);
    // Tensor đều: x=40u, y=40v. Điểm ngoài đường chéo bắt đảo p12/p21;
    // chỉ đo ở u=v hoặc màu đặc sẽ bỏ sót lỗi mapping control point.
    assert_float_ink(
        &page,
        30,
        29,
        [0., 0., 0., 1. - 30.5 / PAGE],
        1e-4,
        "Table86 đặt p11,p12,p22,p21 đúng hướng",
    );
}

#[test]
fn c2c_last_patch_wins_before_shading_opacity_is_applied_once() {
    let mut data = Vec::new();
    for gray in [0, 255] {
        data.push(0);
        data.extend(coons_rect(0., 0., PAGE, PAGE));
        data.extend([gray; 4]);
    }
    let doc = mesh_document(
        6,
        dictionary! {},
        data,
        "1 0 0 0 k 0 0 40 40 re f /A gs /Sh0 sh",
        dictionary! { "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5 } } },
    );
    let page = render_page(&doc, 1, 72., PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert_float_ink(
        &page,
        13,
        17,
        [0.5, 0., 0., 0.],
        2e-6,
        "Patch trắng sau thắng patch đen, rồi toàn shading áp opacity.5 một lần",
    );
}

#[test]
fn c2c_compact_mesh_does_not_drop_a_valid_2001st_patch() {
    let mut data = Vec::new();
    for _ in 0..2000 {
        data.push(0);
        data.extend(coons_rect(0., 0., 1., 1.));
        data.extend([0; 4]);
    }
    data.push(0);
    data.extend(coons_rect(0., 0., PAGE, PAGE));
    data.extend([0; 4]);
    let page = render_mesh(6, dictionary! {}, data);
    assert_eq!(
        page.warnings.dropped_objects, 0,
        "2001 patch không được bị biến thành shading rỗng vì trần tam giác khai triển: {:?}",
        page.warnings
    );
    assert_float_ink(
        &page,
        20,
        20,
        [0., 0., 0., 1.],
        2e-6,
        "Patch cuối hợp lệ vẫn lên mực",
    );
}

#[test]
fn c2c_folded_tensor_uses_the_larger_internal_parameter_on_each_axis() {
    for folded_u in [false, true] {
        let regular = [0., PAGE / 3., PAGE * 2. / 3., PAGE];
        let folded = [0., PAGE, PAGE, 0.];
        let xs = if folded_u { folded } else { regular };
        let ys = if folded_u { regular } else { folded };
        let mut data = vec![0];
        // Table86: 12 điểm biên, tiếp theo p11,p12,p22,p21.
        for index in [0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4, 5, 6, 10, 9] {
            data.extend([q(xs[index % 4]), q(ys[index / 4])]);
        }
        data.extend(if folded_u {
            [0, 255, 255, 0]
        } else {
            [0, 0, 255, 255]
        });
        let page = render_mesh(7, dictionary! {}, data);
        let (x, y) = if folded_u { (22, 19) } else { (20, 17) };
        // 120t(1-t)=22.5 có nghiệm .25/.75; vùng tự gập chọn nghiệm lớn.
        // Sai số <=.01 dành riêng cho hình học chia10ô, không nới cho màu.
        assert_float_ink(
            &page,
            x,
            y,
            [0., 0., 0., 0.25],
            0.01,
            "Tự gập chọn tham số lớn, không dùng thứ tự tam giác ngẫu nhiên",
        );
        if !folded_u {
            // Cùng internal u về mặt toán học vẫn có thể lệch vài ULP sau
            // barycentric. Khi đó phải xét v lớn, không để sai số u lật nhánh.
            let expected_k = |raster_y: usize| {
                let pdf_y = PAGE - raster_y as f32 - 0.5;
                (1. - (1. - pdf_y / 30.).sqrt()) / 2.
            };
            assert_float_ink(
                &page,
                1,
                36,
                [0., 0., 0., expected_k(36)],
                0.01,
                "Cùng u trong sai số số học phải chọn v lớn, không nhánh v≈0.0324",
            );
            // Miền PDFy≤24.5 tránh đỉnh tiếp tuyến y=30, nơi sai số hình học
            // lưới10ô tăng. Trong miền này sai số nội suy hình học <.01.
            for y in 15..40 {
                for x in 0..40 {
                    assert_float_ink(
                        &page,
                        x,
                        y,
                        [0., 0., 0., expected_k(y)],
                        0.01,
                        "Sweep tự gập: u bằng nhau phải ưu tiên v lớn trên toàn vùng",
                    );
                }
            }
        }
    }
}

#[test]
fn c2c_folded_tensor_prioritizes_internal_u_before_internal_v() {
    let mut data = vec![0];
    // Mặt x=20(u+v), y=40uv có hai nghiệm (u,v) hoán đổi nhau. Ở đây
    // u lớn đi với v nhỏ: khác ca gập từng trục, thứ tự ưu tiên có ý nghĩa.
    for index in [0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4, 5, 6, 10, 9] {
        let u = (index % 4) as f32 / 3.;
        let v = (index / 4) as f32 / 3.;
        data.extend([q(20. * (u + v)), q(PAGE * u * v)]);
    }
    data.extend([0, 255, 255, 0]); // Gray=u nên quan sát được nghiệm được chọn.
    let page = render_mesh(7, dictionary! {}, data);
    // PDF(20.5,7.5): u+v=1.025, uv=.1875. Chọn u lớn≈.78665 cho
    // K≈.21335; đảo ưu tiên v sẽ ra K≈.76165. Tolerance .02 bao riêng
    // lượng hóa8bit và chia lưới10ô, nhỏ hơn nhiều chênh lệch hai nghiệm.
    let sum: f32 = 20.5 / 20.;
    let product = 7.5 / PAGE;
    let u = (sum + (sum * sum - 4. * product).sqrt()) / 2.;
    assert_float_ink(
        &page,
        20,
        32,
        [0., 0., 0., 1. - u],
        0.02,
        "PDFv lớn nhất trước PDFu: internal u thắng dù internal v nhỏ hơn",
    );
}

fn black_shading_document(shading_type: i64, content: &str) -> Document {
    let mut extra = dictionary! { "ColorSpace" => "DeviceCMYK" };
    let data = if shading_type == 4 {
        extra.set(
            "Decode",
            vec![
                0.into(),
                40.into(),
                0.into(),
                40.into(),
                0.into(),
                1.into(),
                0.into(),
                1.into(),
                0.into(),
                1.into(),
                0.into(),
                1.into(),
            ],
        );
        let mut data = Vec::new();
        for (flag, x, y) in [(0, 0., 0.), (0, PAGE, 0.), (0, 0., PAGE), (1, PAGE, PAGE)] {
            data.extend([flag, q(x), q(y), 0, 0, 0, 255]);
        }
        data
    } else {
        extra.set("Coords", vec![0.into(), 0.into(), 40.into(), 0.into()]);
        extra.set("Extend", vec![Object::Boolean(true), Object::Boolean(true)]);
        extra.set(
            "Function",
            dictionary! {
                "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()], "N" => 1,
                "C0" => vec![0.into(), 0.into(), 0.into(), 1.into()],
                "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
            },
        );
        Vec::new()
    };
    mesh_document(shading_type, extra, data, content, dictionary! {})
}

#[test]
fn c2c_knockout_mesh_and_axial_keep_shape_separate_from_ca_ais_and_soft_mask() {
    for shading_type in [2, 4] {
        for isolated in [false, true] {
            for ais in [false, true] {
                for alpha in [0., 0.5, 1.] {
                    for mask_alpha in [0., 0.5, 1.] {
                        let mut doc = black_shading_document(
                            shading_type,
                            "0 1 0 0 k 4 4 32 32 re f /A gs q 12 12 16 16 re W n /Sh0 sh Q",
                        );
                        let page_id = *doc.get_pages().get(&1).unwrap();
                        let mut page_dict = doc.get_dictionary(page_id).unwrap().clone();
                        let resources_id =
                            page_dict.get(b"Resources").unwrap().as_reference().unwrap();
                        let content_id =
                            page_dict.get(b"Contents").unwrap().as_reference().unwrap();
                        let content = doc
                            .get_object(content_id)
                            .unwrap()
                            .as_stream()
                            .unwrap()
                            .content
                            .clone();
                        let mask = doc.add_object(Stream::new(dictionary! {
                            "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
                            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK", "I" => true },
                            "Resources" => dictionary! { "ExtGState" => dictionary! {
                                "M" => dictionary! { "ca" => mask_alpha },
                            } },
                        }, b"/M gs 0 0 0 1 k 0 0 40 40 re f".to_vec()));
                        let mut resources = doc.get_dictionary(resources_id).unwrap().clone();
                        resources.set(
                            "ExtGState",
                            dictionary! { "A" => dictionary! {
                                "ca" => alpha, "AIS" => ais,
                                "SMask" => dictionary! { "S" => "Alpha", "G" => mask },
                            } },
                        );
                        doc.set_object(resources_id, resources);
                        let group = doc.add_object(Stream::new(dictionary! {
                            "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
                            "Resources" => resources_id,
                            "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK",
                                "I" => isolated, "K" => true },
                        }, content));
                        let root_content = doc.add_object(Stream::new(
                            dictionary! {},
                            b"1 0 0 0 k 0 0 40 40 re f /Outer Do".to_vec(),
                        ));
                        page_dict.set("Contents", root_content);
                        page_dict.set(
                            "Resources",
                            dictionary! { "XObject" => dictionary! { "Outer" => group } },
                        );
                        page_dict.set("Group", dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK", "I" => true });
                        doc.set_object(page_id, page_dict);
                        let page =
                            render_page(&doc, 1, 72., PageBox::Crop, RenderOptions::ink_accurate())
                                .unwrap();
                        let a = alpha * mask_alpha;
                        let expected = if ais {
                            [0., 1. - a, 0., a]
                        } else {
                            [1. - a, 0., 0., a]
                        };
                        assert_float_ink(&page, 20, 20, expected, 2e-6,
                            &format!("Shading{shading_type} I={isolated} AIS={ais} ca={alpha} SMask={mask_alpha}"));
                        assert_float_ink(
                            &page,
                            8,
                            20,
                            [0., 1., 0., 0.],
                            2e-6,
                            "Ngoài clip của shading vẫn giữ siblingM",
                        );
                        assert!(
                            page.warnings.unsupported_transparency && page.warnings.ink_unsound(),
                            "Các fixture C2c không tự gỡ guard K toàn domain: {:?}",
                            page.warnings
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn c2c_regular_axial_remains_one_half_opacity_object() {
    let mut doc = black_shading_document(2, "1 0 0 0 k 0 0 40 40 re f /A gs /Sh0 sh");
    let page_id = *doc.get_pages().get(&1).unwrap();
    let page_dict = doc.get_dictionary(page_id).unwrap();
    let resources_id = page_dict.get(b"Resources").unwrap().as_reference().unwrap();
    let mut resources = doc.get_dictionary(resources_id).unwrap().clone();
    resources.set(
        "ExtGState",
        dictionary! { "A" => dictionary! { "ca" => 0.5 } },
    );
    doc.set_object(resources_id, resources);
    let page = render_page(&doc, 1, 72., PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert_float_ink(
        &page,
        20,
        20,
        [0.5, 0., 0., 0.5],
        2e-6,
        "Axial thường giữ đúng opacity khi bổ sung nhánh group",
    );
    assert!(!page.warnings.ink_unsound(), "{:?}", page.warnings);
}

#[test]
fn c2c_patch_viewport_matches_full_page_with_a_nonzero_local_origin() {
    for shading_type in [6, 7] {
        let mut data = vec![0];
        data.extend(if shading_type == 6 {
            coons_rect(0., 0., PAGE, PAGE)
        } else {
            tensor_rect()
        });
        data.extend([0, 0, 255, 0]);
        let doc = mesh_document(
            shading_type,
            dictionary! { "ColorSpace" => "DeviceCMYK", "Function" => black_function(2) },
            data,
            "1 0 0 0 k 0 0 40 40 re f /A gs /Sh0 sh",
            dictionary! { "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5 } } },
        );
        for viewer in [false, true] {
            let options = if viewer {
                RenderOptions::viewer()
            } else {
                RenderOptions::ink_accurate()
            };
            let full = render_page(&doc, 1, 72., PageBox::Crop, options.clone()).unwrap();
            // Gốc24 lớn hơn guard-band16: buffer phụ có CTM dịch thật, không
            // chỉ là crop từ buffer vẫn bắt đầu tại(0,0).
            let crop = RasterClip {
                x: 24,
                y: 24,
                width: 8,
                height: 8,
            };
            let clipped =
                render_page_managed_region(&doc, 1, 72., PageBox::Crop, options, None, Some(crop))
                    .unwrap();
            assert_eq!((clipped.buffer.width(), clipped.buffer.height()), (8, 8));
            for y in 0..8usize {
                for x in 0..8usize {
                    let index =
                        (y + crop.y as usize) * full.buffer.width() as usize + x + crop.x as usize;
                    let expected = std::array::from_fn(|channel| full.buffer.plane(channel)[index]);
                    assert_float_ink(
                        &clipped,
                        x,
                        y,
                        expected,
                        3e-6,
                        "Viewport mesh phải giữ pha UV/Function/opacity như full-page",
                    );
                }
            }
            assert!(!clipped.warnings.ink_unsound(), "{:?}", clipped.warnings);
            assert!(
                clipped.buffer.memory_used_bytes() < full.buffer.memory_used_bytes(),
                "Buffer kết quả phải thu về đúng kích thước viewport"
            );
        }
    }
}

#[test]
fn c2c_mesh_scratch_budget_fails_loud_and_is_refunded_after_each_object() {
    let data = [
        v4(0, 0., 0., 0),
        v4(0, PAGE, 0., 0),
        v4(0, 0., PAGE, 0),
        v4(1, PAGE, PAGE, 0),
    ]
    .concat();
    let resources =
        dictionary! { "ExtGState" => dictionary! { "A" => dictionary! { "ca" => 0.5 } } };
    let doc = mesh_document(
        4,
        dictionary! {},
        data.clone(),
        "/A gs /Sh0 sh /Sh0 sh",
        resources,
    );
    let empty = mesh_document(4, dictionary! {}, data, "", dictionary! {});
    // 40×40 CMYK+alpha tốn32k; budget64k đủ trang+raster nhưng không đủ
    // scratch ownership khoảng38.4k. Không được biến thiếu RAM thành PDF trắng.
    let baseline = render_page(
        &empty,
        1,
        72.,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(64_000),
    )
    .unwrap();
    let failure = render_page(
        &doc,
        1,
        72.,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(64_000),
    );
    assert!(
        matches!(failure, Err(PpeError::MemoryBudgetExceeded { .. })),
        "Thiếu scratch mesh phải trả lỗi ngân sách rõ ràng"
    );

    // Budget96k chứa một scratch nhưng không chứa hai bản cùng lúc. Hai sh
    // liên tiếp vẫn chạy: lease của object trước phải trả trước object sau.
    let page = render_page(
        &doc,
        1,
        72.,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_memory_budget_bytes(96_000),
    )
    .unwrap();
    assert_float_ink(
        &page,
        20,
        20,
        [0., 0., 0., 0.75],
        2e-6,
        "Hai shading riêng vẫn composite hai lần, khác hai tam giác một shading",
    );
    assert!(!page.warnings.ink_unsound(), "{:?}", page.warnings);
    assert_eq!(
        page.buffer.memory_used_bytes(),
        baseline.buffer.memory_used_bytes(),
        "Không giữ lại lease nguồn/scratch mesh sau khi render kết thúc"
    );
}
