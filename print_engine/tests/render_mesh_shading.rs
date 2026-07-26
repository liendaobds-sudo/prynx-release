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
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: f32 = 40.0;

/// Lượng hoá toạ độ về byte theo `/Decode [0 40 0 40]`.
fn q(v: f32) -> u8 {
    (v / PAGE * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Dựng trang tô một shading lưới bằng `sh`.
fn render_mesh(shading_type: i64, extra: Dictionary, data: Vec<u8>) -> PageRender {
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
    let resources = doc.add_object(dictionary! {
        "Shading" => dictionary! { "Sh0" => Object::Reference(shading) },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"/Sh0 sh".to_vec()));
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

    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
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
    assert_eq!(r.warnings.dropped_objects, 0, "{:?}", r.warnings.skipped_ops);
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
    assert_eq!(px(&r, 3, w - 3, 2), 255, "tam giác thứ hai phải phủ góc kia");
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
    let vertex = |flag: u8, x: f32, y: f32| -> Vec<u8> {
        vec![flag, q(x), q(y), 255, 255, 255, 255]
    };
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
    assert_eq!(r.warnings.dropped_objects, 0, "{:?}", r.warnings.skipped_ops);
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
    assert_eq!(r.warnings.dropped_objects, 0, "{:?}", r.warnings.skipped_ops);
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
    // Bốn điểm trong, theo thứ tự p11, p21, p22, p12 của lưới 4×4.
    for (x, y) in [
        (PAGE / 3.0, PAGE / 3.0),
        (PAGE / 3.0, PAGE * 2.0 / 3.0),
        (PAGE * 2.0 / 3.0, PAGE * 2.0 / 3.0),
        (PAGE * 2.0 / 3.0, PAGE / 3.0),
    ] {
        data.push(q(x));
        data.push(q(y));
    }
    data.extend_from_slice(&[0, 0, 0, 0]);
    let r = render_mesh(7, dictionary! {}, data);
    assert_eq!(r.warnings.dropped_objects, 0, "{:?}", r.warnings.skipped_ops);
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
    let names: Vec<&str> = r.buffer.space().colorants().iter().map(|c| c.name()).collect();
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
    let r = render_mesh(4, dictionary! { "Decode" => vec![0.into(), 40.into()] }, data);
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
