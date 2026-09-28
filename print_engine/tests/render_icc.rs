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
fn calrgb_never_reports_clean_while_calibration_is_not_applied() {
    let cm = cm_or_skip!();
    let mut doc = Document::with_version("1.7");
    let resources_id = doc.add_object(dictionary! {
        "ColorSpace" => dictionary! {
            "CS0" => Object::Array(vec![
                "CalRGB".into(),
                Object::Dictionary(dictionary! {
                    "WhitePoint" => vec![0.9505.into(), 1.into(), 1.089.into()],
                    "Gamma" => vec![2.2.into(), 2.2.into(), 2.2.into()],
                    "Matrix" => vec![
                        0.64.into(), 0.33.into(), 0.03.into(),
                        0.30.into(), 0.60.into(), 0.10.into(),
                        0.15.into(), 0.06.into(), 0.79.into(),
                    ],
                }),
            ]),
        },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"/CS0 cs 0.2 0.8 0.4 scn 0 0 10 10 re f".to_vec(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog =
        doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => Object::Reference(pages_id) });
    doc.trailer.set("Root", Object::Reference(catalog));

    let rendered = render_page_managed(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
        Some(&cm),
    )
    .unwrap();
    assert!(rendered.warnings.ink_unsound(), "{:?}", rendered.warnings);
    assert!(rendered
        .warnings
        .approximated_colorspaces
        .iter()
        .any(|item| item.contains("CalRGB")));
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

// COLOR (audit 2026-09-28 §KNOCK.04): Lab nhúng không có miền RGB0..1.
fn embedded_lab_resources(doc: &mut Document) -> Dictionary {
    let profile = lcms2::Profile::new_lab4_context(lcms2::GlobalContext::new(),
        &lcms2::CIExyY { x: 0.3457, y: 0.3585, Y: 1.0 }).unwrap();
    let mut stream = Stream::new(dictionary! {
        "N" => 3,
        "Range" => vec![0.into(), 100.into(), (-128).into(), 127.into(), (-128).into(), 127.into()],
        "Alternate" => vec!["Lab".into(), Object::Dictionary(dictionary! {
            "WhitePoint" => vec![0.9642.into(), 1.into(), 0.8249.into()],
        })],
    }, profile.icc().unwrap());
    stream.compress().unwrap();
    let profile_id = doc.add_object(stream);
    dictionary! { "ColorSpace" => dictionary! {
        "CS0" => vec!["ICCBased".into(), Object::Reference(profile_id)],
    } }
}

fn render_icc_doc(doc: &Document, cm: &ColorManager) -> PageRender {
    render_page_managed(doc, 1, 72., PageBox::Crop, RenderOptions::softproof(), Some(cm)).unwrap()
}

fn replace_resources(doc: &mut Document, resources: Dictionary) {
    let page = *doc.get_pages().get(&1).unwrap();
    doc.get_object_mut(page).unwrap().as_dict_mut().unwrap()
        .set("Resources", resources);
}

#[test]
fn embedded_lab_vector_keeps_physical_lab_components() {
    let cm = cm_or_skip!();
    let mut doc = build("/CS0 cs 64.7059 59 68 scn 0 0 10 10 re f");
    let resources = embedded_lab_resources(&mut doc);
    replace_resources(&mut doc, resources);
    let page = render_icc_doc(&doc, &cm);
    let expected = cm.lab_to_cmyk(64.7059, 59., 68.).unwrap();
    for (ch, expected) in expected.iter().enumerate() {
        let actual = page.buffer.plate_u8(ch)[center(&page)] as f32 / 255.;
        assert!((actual - expected).abs() < 0.01, "kênh{ch}: {actual} != {expected}");
    }
    assert!(!page.warnings.ink_unsound(), "{:?}", page.warnings);
}

#[test]
fn embedded_lab_spot_alternate_does_not_turn_pantone_white() {
    let cm = cm_or_skip!();
    let mut doc = build("/Spot cs 1 scn 0 0 10 10 re f");
    let mut resources = embedded_lab_resources(&mut doc);
    let spaces = resources.get_mut(b"ColorSpace").unwrap().as_dict_mut().unwrap();
    let lab = spaces.get(b"CS0").unwrap().clone();
    spaces.set("Spot", vec!["Separation".into(), "Orange".into(), lab,
        Object::Dictionary(dictionary! {
            "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()], "N" => 1,
            "C0" => vec![100.into(), 0.into(), 0.into()],
            "C1" => vec![64.7059.into(), 59.into(), 68.into()],
        })]);
    replace_resources(&mut doc, resources);
    let page = render_icc_doc(&doc, &cm);
    assert_eq!(page.buffer.plate_u8(4)[center(&page)], 255, "kẽm spot giữ nguyên");
    let lut = page.buffer.space().spot_alternate(4).unwrap();
    let actual = lut.cmyk_at(1.);
    let expected = cm.lab_to_cmyk(64.7059, 59., 68.).unwrap();
    for ch in 0..4 { assert!((actual[ch]-expected[ch]).abs()<0.01, "{actual:?} != {expected:?}"); }
    assert!(lut.cmyk_at(0.).iter().sum::<f32>() < 0.02);
}

#[test]
fn embedded_lab_image_and_indexed_render_lab_but_guard_unverified_range() {
    let cm = cm_or_skip!();
    for indexed in [false, true] {
        let mut doc = build("q 10 0 0 10 0 0 cm /Im0 Do Q");
        let mut resources = embedded_lab_resources(&mut doc);
        let lab = resources.get(b"ColorSpace").unwrap().as_dict().unwrap().get(b"CS0").unwrap().clone();
        let cs = if indexed { Object::Array(vec!["Indexed".into(), lab, 0.into(),
            Object::String(vec![165,187,196], lopdf::StringFormat::Hexadecimal)]) } else { lab };
        let img = doc.add_object(Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "BitsPerComponent" => 8, "ColorSpace" => cs,
        }, if indexed { vec![0] } else { vec![165,187,196] }));
        resources.set("XObject", dictionary! { "Im0" => Object::Reference(img) });
        replace_resources(&mut doc, resources);
        let page = render_icc_doc(&doc, &cm);
        let expected = cm.lab_to_cmyk(165. / 255. * 100., 59., 68.).unwrap();
        for ch in 0..4 {
            let actual = page.buffer.plate_u8(ch)[center(&page)] as f32 / 255.;
            assert!((actual - expected[ch]).abs()<0.01, "indexed={indexed}, ch={ch}: {actual} != {}", expected[ch]);
        }
        assert!(page.warnings.ink_unsound(), "IR chưa giữ Range nên không chứng nhận ảnh: {:?}", page.warnings);
    }
}

#[test]
fn embedded_lab_header_is_used_without_alternate_and_without_compression() {
    let cm = cm_or_skip!();
    let mut doc = build("/CS0 cs 31.3725 50 14 scn 0 0 10 10 re f");
    let resources = embedded_lab_resources(&mut doc);
    let profile = resources.get(b"ColorSpace").unwrap().as_dict().unwrap()
        .get(b"CS0").unwrap().as_array().unwrap()[1].as_reference().unwrap();
    let stream = doc.get_object_mut(profile).unwrap().as_stream_mut().unwrap();
    let bytes = stream.decompressed_content().unwrap();
    *stream = Stream::new(dictionary! { "N" => 3,
        "Range" => vec![0.into(), 100.into(), (-128).into(), 127.into(), (-128).into(), 127.into()],
    }, bytes);
    replace_resources(&mut doc, resources);
    let page = render_icc_doc(&doc, &cm);
    let expected = cm.lab_to_cmyk(31.3725, 50., 14.).unwrap();
    for ch in 0..4 {
        let actual = page.buffer.plate_u8(ch)[center(&page)] as f32 / 255.;
        assert!((actual - expected[ch]).abs() < 0.01);
    }
    assert!(!page.warnings.ink_unsound());
}

#[test]
fn broken_icc_spot_alternate_degrades_preview_but_not_the_measured_spot_plate() {
    let cm = cm_or_skip!();
    let mut doc = build("/Spot cs 1 scn 0 0 10 10 re f");
    let profile = doc.add_object(Stream::new(dictionary! {
        "N" => 3, "Alternate" => vec!["Lab".into(), Object::Dictionary(dictionary! {})],
    }, b"profile hong".to_vec()));
    replace_resources(&mut doc, dictionary! { "ColorSpace" => dictionary! {
        "Spot" => vec!["Separation".into(), "Orange".into(),
            Object::Array(vec!["ICCBased".into(), Object::Reference(profile)]),
            Object::Dictionary(dictionary! {
                "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()], "N" => 1,
                "C0" => vec![100.into(), 0.into(), 0.into()],
                "C1" => vec![64.7059.into(), 59.into(), 68.into()],
            })],
    } });
    let preview = render_icc_doc(&doc, &cm);
    assert!(preview.warnings.ink_unsound(), "alternate hỏng phải hạ proof");
    assert!(!preview.warnings.approximated_colorspaces.is_empty());
    let measured = render_page_managed(&doc, 1, 72., PageBox::Crop,
        RenderOptions::ink_accurate(), Some(&cm)).unwrap();
    assert_eq!(measured.buffer.plate_u8(4)[center(&measured)], 255);
    assert!(!measured.warnings.ink_unsound(), "ICC không đổi lượng mực trên kẽm spot");
}

#[test]
fn valid_embedded_lab_does_not_evaluate_unused_alternate() {
    let cm = cm_or_skip!();
    for alternate in [Object::Name(b"KhongTonTai".to_vec()),
        Object::Array(vec!["CalRGB".into(), Object::Dictionary(dictionary! {})])] {
        let mut doc = build("/CS0 cs 64.7059 59 68 scn 0 0 10 10 re f");
        let resources = embedded_lab_resources(&mut doc);
        let id = resources.get(b"ColorSpace").unwrap().as_dict().unwrap()
            .get(b"CS0").unwrap().as_array().unwrap()[1].as_reference().unwrap();
        doc.get_object_mut(id).unwrap().as_stream_mut().unwrap().dict.set("Alternate", alternate);
        replace_resources(&mut doc, resources);
        let page = render_icc_doc(&doc, &cm);
        assert!(!page.warnings.ink_unsound(), "{:?}", page.warnings);
        assert!(page.buffer.plate_u8(1)[center(&page)] > 150);
    }
}

#[test]
fn embedded_cmyk_keeps_process_plates_despite_a_devicen_alternate() {
    let cm = cm_or_skip!();
    let mut doc = build("/CS0 cs 1 1 1 1 scn 0 0 10 10 re f");
    let profile = doc.add_object(Stream::new(dictionary! { "N" => 4,
        "Alternate" => vec!["DeviceN".into(),
            Object::Array(vec!["SpotA".into(), "SpotB".into(), "SpotC".into(), "SpotD".into()]),
            "DeviceCMYK".into(), Object::Dictionary(dictionary! {
                "FunctionType" => 4, "Domain" => vec![0.into(),1.into(),0.into(),1.into(),0.into(),1.into(),0.into(),1.into()],
            })],
    }, std::fs::read(icc_dir().join("FOGRA39.icc")).unwrap()));
    replace_resources(&mut doc, dictionary! { "ColorSpace" => dictionary! {
        "CS0" => vec!["ICCBased".into(), Object::Reference(profile)],
    } });
    let page = render_icc_doc(&doc, &cm);
    assert_eq!(page.buffer.space().len(), 4);
    for ch in 0..4 { assert_eq!(page.buffer.plate_u8(ch)[center(&page)], 255); }
    assert!(!page.warnings.ink_unsound());
}

#[test]
fn embedded_lab_matte_is_not_silently_clamped_to_unit_range() {
    let cm = cm_or_skip!();
    let mut doc = build("q 10 0 0 10 0 0 cm /Im0 Do Q");
    let mut resources = embedded_lab_resources(&mut doc);
    let lab = resources.get(b"ColorSpace").unwrap().as_dict().unwrap()
        .get(b"CS0").unwrap().clone();
    let mask = doc.add_object(Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
        "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray", "Matte" => vec![100.into(), 0.into(), 0.into()],
    }, vec![128]));
    let image = doc.add_object(Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
        "BitsPerComponent" => 8, "ColorSpace" => lab, "SMask" => Object::Reference(mask),
    }, vec![191,128,128]));
    resources.set("XObject", dictionary! { "Im0" => Object::Reference(image) });
    replace_resources(&mut doc, resources);
    let page = render_icc_doc(&doc, &cm);
    assert!(page.warnings.unsupported_transparency);
    assert!(page.warnings.skipped_ops.iter().any(|(op,_)| op.contains("Matte")));
}

#[test]
fn embedded_lab_custom_range_is_guarded() {
    let cm = cm_or_skip!();
    let mut doc = build("/CS0 cs 25 0 0 scn 0 0 10 10 re f");
    let resources = embedded_lab_resources(&mut doc);
    let id = resources.get(b"ColorSpace").unwrap().as_dict().unwrap()
        .get(b"CS0").unwrap().as_array().unwrap()[1].as_reference().unwrap();
    doc.get_object_mut(id).unwrap().as_stream_mut().unwrap().dict.set("Range",
        vec![0.into(),50.into(),(-60).into(),60.into(),(-60).into(),60.into()]);
    replace_resources(&mut doc, resources);
    assert!(render_icc_doc(&doc, &cm).warnings.ink_unsound());
}
