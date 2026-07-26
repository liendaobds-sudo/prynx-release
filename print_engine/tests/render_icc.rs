//! Test tích hợp quản lý màu ICC ở mức render trang.
//!
//! Trọng tâm không phải "màu có đẹp không" mà là một bất biến prepress:
//! **ICC chỉ dùng để đưa nội dung chưa-phải-mực vào không gian mực; dữ liệu đã là
//! mực thì không bao giờ đi qua ICC.** Vi phạm điều đó là cách âm thầm nhất để
//! biến một file vượt giới hạn mực thành "đạt".

use std::path::{Path, PathBuf};

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page_managed, PageBox, PageRender};

fn icc_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("backend/app/assets/icc")
}

fn manager() -> Option<ColorManager> {
    let cmyk = icc_dir().join("FOGRA39.icc");
    if !cmyk.is_file() {
        return None;
    }
    let srgb = icc_dir().join("sRGB.icc");
    ColorManager::from_profiles(
        &cmyk,
        if srgb.is_file() {
            Some(srgb.as_path())
        } else {
            None
        },
        RenderIntent::default(),
    )
    .ok()
}

macro_rules! cm_or_skip {
    () => {
        match manager() {
            Some(cm) => cm,
            None => {
                eprintln!("bỏ qua: không có FOGRA39.icc");
                return;
            }
        }
    };
}

fn build(content: &str) -> Document {
    let mut doc = Document::with_version("1.7");
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let resources_id = doc.add_object(Dictionary::new());
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

fn render(content: &str, cm: Option<&ColorManager>) -> PageRender {
    let doc = build(content);
    render_page_managed(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
        cm,
    )
    .expect("render phải thành công")
}

fn center(r: &PageRender) -> usize {
    let w = r.buffer.width() as usize;
    (r.buffer.height() as usize / 2) * w + w / 2
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bất biến: mực không đi qua ICC
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn device_cmyk_solid_stays_400_percent_even_with_icc_loaded() {
    // Bài test quan trọng nhất của file này. Nếu DeviceCMYK bị round-trip qua
    // ICC, vùng đặc tụt xuống ~292% và một file 400% sẽ được báo là đạt ngưỡng
    // 300%. Có profile nạp sẵn KHÔNG được làm đổi con số này.
    let cm = cm_or_skip!();
    let r = render("1 1 1 1 k 0 0 10 10 re f", Some(&cm));
    assert!(
        (r.buffer.max_tac_percent() - 400.0).abs() < 0.5,
        "TAC = {}",
        r.buffer.max_tac_percent()
    );
}

#[test]
fn device_cmyk_is_bit_identical_with_and_without_icc() {
    let cm = cm_or_skip!();
    let with = render("0.6 0.4 0.4 1 k 0 0 10 10 re f", Some(&cm));
    let without = render("0.6 0.4 0.4 1 k 0 0 10 10 re f", None);
    for ch in 0..4 {
        assert_eq!(
            with.buffer.plate_u8(ch)[center(&with)],
            without.buffer.plate_u8(ch)[center(&without)],
            "kênh {ch} phải không đổi khi nạp ICC"
        );
    }
}

#[test]
fn device_gray_still_maps_to_k_only_with_icc() {
    // `DeviceGray` là không gian THIẾT BỊ: đen của nó là K thuần. Nếu đưa qua ICC
    // nó thành rich black 4 màu, và chữ nhỏ sẽ lệch bản khi in.
    let cm = cm_or_skip!();
    let r = render("0 g 0 0 10 10 re f", Some(&cm));
    let i = center(&r);
    assert_eq!(r.buffer.plate_u8(3)[i], 255, "K phải đặc");
    assert_eq!(r.buffer.plate_u8(0)[i], 0, "Cyan phải trắng");
    assert_eq!(r.buffer.plate_u8(1)[i], 0);
    assert_eq!(r.buffer.plate_u8(2)[i], 0);
}

#[test]
fn spot_channel_is_untouched_by_icc() {
    // Tint của mực pha là lượng mực, không phải màu cần quy đổi.
    let cm = cm_or_skip!();
    let mut doc = Document::with_version("1.7");
    let tint = dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        "C1" => vec![0.into(), 1.into(), 1.into(), 0.into()],
        "N" => 1,
        "Range" => vec![0.into(), 1.into(), 0.into(), 1.into(), 0.into(), 1.into(), 0.into(), 1.into()],
    };
    let resources = dictionary! {
        "ColorSpace" => dictionary! {
            "CS0" => vec![
                "Separation".into(),
                Object::Name(b"PANTONE 485 C".to_vec()),
                "DeviceCMYK".into(),
                Object::Dictionary(tint),
            ],
        },
    };
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"/CS0 cs 1 scn 0 0 10 10 re f".to_vec(),
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

    let r = render_page_managed(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
        Some(&cm),
    )
    .unwrap();
    let spot = r
        .buffer
        .space()
        .colorants()
        .iter()
        .position(|c| c.name() == "PANTONE 485 C")
        .expect("phải có kẽm spot");
    let i = center(&r);
    assert_eq!(r.buffer.plate_u8(spot)[i], 255);
    for ch in 0..4 {
        assert_eq!(
            r.buffer.plate_u8(ch)[i],
            0,
            "spot không được rơi sang process"
        );
    }
    assert!((r.buffer.max_tac_percent() - 100.0).abs() < 0.5);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ICC được áp cho nội dung chưa phải mực
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn rgb_with_icc_is_not_flagged_approximate() {
    let cm = cm_or_skip!();
    let r = render("0.2 0.4 0.6 rg 0 0 10 10 re f", Some(&cm));
    assert!(
        !r.warnings.degrades_accuracy(),
        "có ICC thì RGB không còn là xấp xỉ: {:?}",
        r.warnings
    );
}

#[test]
fn rgb_without_icc_is_flagged_approximate() {
    let r = render("0.2 0.4 0.6 rg 0 0 10 10 re f", None);
    assert!(r.warnings.degrades_accuracy());
    assert!(
        r.warnings
            .approximated_colorspaces
            .iter()
            .any(|c| c.contains("RGB")),
        "{:?}",
        r.warnings.approximated_colorspaces
    );
}

#[test]
fn icc_changes_rgb_result_versus_naive_formula() {
    // Nếu hai đường cho cùng kết quả thì ICC chưa hề được áp.
    let cm = cm_or_skip!();
    let managed = render("0 0 0 rg 0 0 10 10 re f", Some(&cm));
    let naive = render("0 0 0 rg 0 0 10 10 re f", None);
    let d = (managed.buffer.max_tac_percent() - naive.buffer.max_tac_percent()).abs();
    assert!(d > 50.0, "ICC phải cho kết quả khác rõ rệt, lệch = {d}");
}

#[test]
fn rgb_black_via_icc_generates_rich_black_not_k_only() {
    // Đây là điểm ICC khác công thức naive: RGB đen thành rich black có đủ 4 mực,
    // đúng như RIP làm. Công thức UCR naive cho K-only 100%.
    let cm = cm_or_skip!();
    let r = render("0 0 0 rg 0 0 10 10 re f", Some(&cm));
    let i = center(&r);
    for ch in 0..4 {
        assert!(
            r.buffer.plate_u8(ch)[i] > 100,
            "kênh {ch} phải có mực đáng kể: {}",
            r.buffer.plate_u8(ch)[i]
        );
    }
}

#[test]
fn rgb_white_via_icc_leaves_paper_clean() {
    let cm = cm_or_skip!();
    let r = render("1 1 1 rg 0 0 10 10 re f", Some(&cm));
    assert!(
        r.buffer.max_tac_percent() < 2.0,
        "{}",
        r.buffer.max_tac_percent()
    );
}

#[test]
fn rgb_image_uses_icc_too() {
    // Đường ảnh và đường vector phải dùng cùng một phép quy đổi; lệch nhau thì
    // cùng một màu sẽ ra hai lượng mực khác nhau tuỳ nó được vẽ kiểu gì.
    let cm = cm_or_skip!();
    let mut doc = Document::with_version("1.7");
    let img = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 1,
        "Height" => 1,
        "BitsPerComponent" => 8,
        "ColorSpace" => "DeviceRGB",
    };
    let img_id = doc.add_object(Stream::new(img, vec![0, 0, 0]));
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

    let via_image = render_page_managed(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
        Some(&cm),
    )
    .unwrap();
    let via_vector = render("0 0 0 rg 0 0 10 10 re f", Some(&cm));

    for ch in 0..4 {
        let a = via_image.buffer.plate_u8(ch)[center(&via_image)];
        let b = via_vector.buffer.plate_u8(ch)[center(&via_vector)];
        assert!(
            (a as i32 - b as i32).abs() <= 1,
            "kênh {ch}: ảnh {a} vs vector {b}"
        );
    }
    assert!(!via_image.warnings.degrades_accuracy());
}

#[test]
fn colorspaces_used_is_reported() {
    // Lớp trên cần biết trang đã dùng họ colorspace nào để giải thích accuracy.
    let cm = cm_or_skip!();
    let r = render("0 0 0 rg 0 0 5 5 re f 0 0 0 1 k 5 5 5 5 re f", Some(&cm));
    assert!(r
        .warnings
        .colorspaces_used
        .contains(&"DeviceRGB".to_string()));
    assert!(r
        .warnings
        .colorspaces_used
        .contains(&"DeviceCMYK".to_string()));
}

#[test]
fn black_point_compensation_toggle_changes_result() {
    let mut cm = cm_or_skip!();
    let a = render("0 0 0 rg 0 0 10 10 re f", Some(&cm));
    cm.set_black_point_compensation(false);
    let b = render("0 0 0 rg 0 0 10 10 re f", Some(&cm));
    assert_ne!(
        a.buffer.plate_u8(0)[center(&a)],
        b.buffer.plate_u8(0)[center(&b)],
        "tắt bù điểm đen phải đổi kết quả (và phải xoá LUT cũ)"
    );
}
