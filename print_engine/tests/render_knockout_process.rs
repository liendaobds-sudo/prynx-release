//! QUALITY (audit 2026-09-28 §KNOCK.PROCESS): DeviceN chỉ gồm mực process
//! phải giữ shape/opacity giống CMYK trong nhóm knockout. Oracle tự tính theo
//! ISO 32000-1 §11.3.5, §11.4.6; không gọi blend/composite của engine.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const BACKDROP: [f64; 4] = [0.2, 0.4, 0.6, 0.3];
const PREVIOUS: [f64; 4] = [0.7, 0.2, 0.1, 0.5];
const FIRST: [f64; 4] = [0.15, 0.25, 0.35, 0.0];
const LAST: [f64; 4] = [0.75, 0.65, 0.95, 0.0];
const MODES: [&str; 12] = [
    "Normal",
    "Multiply",
    "Screen",
    "Overlay",
    "Darken",
    "Lighten",
    "ColorDodge",
    "ColorBurn",
    "HardLight",
    "SoftLight",
    "Difference",
    "Exclusion",
];

#[derive(Clone, Copy, Debug)]
enum SourceSpace {
    Cmyk,
    Cmy,
    Spot,
    Mixed,
    Duplicate,
    Rgb,
}

fn numbers(values: &[f64]) -> Object {
    Object::Array(
        values
            .iter()
            .map(|value| Object::Real(*value as f32))
            .collect(),
    )
}

fn form(
    doc: &mut Document,
    content: &str,
    resources: Dictionary,
    isolated: bool,
    knockout: bool,
) -> Object {
    Object::Reference(doc.add_object(Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
        "Resources" => resources,
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK", "I" => isolated, "K" => knockout },
    }, content.as_bytes().to_vec())))
}

fn color_space(doc: &mut Document, source: SourceSpace) -> Object {
    let names = match source {
        SourceSpace::Cmyk => return Object::Name(b"DeviceCMYK".to_vec()),
        SourceSpace::Rgb => return Object::Name(b"DeviceRGB".to_vec()),
        SourceSpace::Cmy => ["Cyan", "Magenta", "Yellow"],
        SourceSpace::Spot => ["Orange", "Varnish", "White"],
        SourceSpace::Mixed => ["Cyan", "Varnish", "Yellow"],
        SourceSpace::Duplicate => ["Cyan", "Cyan", "Yellow"],
    };
    // Ba đầu vào C/M/Y được giữ nguyên, thêm K=0. Không dùng một output PPE
    // đã render làm oracle cho tint transform.
    let tint = doc.add_object(Stream::new(
        dictionary! {
            "FunctionType" => 4, "Domain" => numbers(&[0., 1., 0., 1., 0., 1.]),
            "Range" => numbers(&[0., 1., 0., 1., 0., 1., 0., 1.]),
        },
        b"{ 0 }".to_vec(),
    ));
    Object::Array(vec![
        Object::Name(b"DeviceN".to_vec()),
        Object::Array(
            names
                .into_iter()
                .map(|name| Object::Name(name.as_bytes().to_vec()))
                .collect(),
        ),
        Object::Name(b"DeviceCMYK".to_vec()),
        Object::Reference(tint),
    ])
}

#[derive(Clone, Copy, Debug)]
struct Scene {
    kind: i64,
    source: SourceSpace,
    alpha: f64,
    ais: bool,
    mask: Option<f64>,
    blend: &'static str,
    boundary: &'static str,
    boundary_alpha: f64,
}

fn fixture(scene: Scene) -> Document {
    fixture_with_path(scene, None)
}

fn fixture_with_path(scene: Scene, stroke: Option<bool>) -> Document {
    let mut doc = Document::with_version("1.7");
    let color_space = color_space(&mut doc, scene.source);
    let components = if matches!(scene.source, SourceSpace::Cmyk) {
        4
    } else {
        3
    };
    let mut shading = dictionary! {
        "ShadingType" => scene.kind, "ColorSpace" => color_space.clone(),
        "Domain" => numbers(&[0., 1.]), "Extend" => vec![true.into(), true.into()],
        "Function" => dictionary! { "FunctionType" => 2, "Domain" => numbers(&[0., 1.]),
            "C0" => numbers(&FIRST[..components]), "C1" => numbers(&LAST[..components]), "N" => 1 },
    };
    shading.set(
        "Coords",
        if scene.kind == 2 {
            numbers(&[0., 0., 40., 0.])
        } else {
            numbers(&[20., 20., 0., 20., 20., 20.])
        },
    );
    let mut graphics = dictionary! {
        // Nét chỉ đọc CA, mảng tô/shading chỉ đọc ca. Giá trị đối nghịch
        // bắt cả lỗi dùng nhầm hằng alpha của loại thao tác còn lại.
        "ca" => if stroke == Some(true) { 1. - scene.alpha as f32 } else { scene.alpha as f32 },
        "CA" => if stroke == Some(false) { 1. - scene.alpha as f32 } else { scene.alpha as f32 },
        "AIS" => scene.ais, "BM" => scene.blend,
    };
    if let Some(alpha) = scene.mask {
        let mask = form(
            &mut doc,
            "/A gs 0 0 0 1 k 0 0 40 40 re f",
            dictionary! {
                "ExtGState" => dictionary! { "A" => dictionary! { "ca" => alpha as f32 } },
            },
            true,
            false,
        );
        graphics.set("SMask", dictionary! { "S" => "Alpha", "G" => mask });
    }
    let paint = if let Some(stroke) = stroke {
        let values = FIRST[..components]
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        if stroke {
            format!("/Process CS {values} SCN 16 w 20 12 m 20 28 l S")
        } else {
            format!("/Process cs {values} scn 12 12 16 16 re f")
        }
    } else {
        "/Sh sh".into()
    };
    let content = format!("0.7 0.2 0.1 0.5 k 4 4 32 32 re f q 12 12 16 16 re W n /A gs {paint} Q");
    let group = form(
        &mut doc,
        &content,
        dictionary! { "Shading" => dictionary! { "Sh" => shading },
        "ColorSpace" => dictionary! { "Process" => color_space },
        "ExtGState" => dictionary! { "A" => graphics } },
        false,
        true,
    );
    let resources = dictionary! {
        "XObject" => dictionary! { "K" => group },
        "ExtGState" => dictionary! { "Boundary" => dictionary! {
            "BM" => scene.boundary, "ca" => scene.boundary_alpha as f32,
        } },
    };
    let contents = doc.add_object(Stream::new(
        dictionary! {},
        b"0.2 0.4 0.6 0.3 k 0 0 40 40 re f /Boundary gs /K Do".to_vec(),
    ));
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "Contents" => contents, "Resources" => resources,
        "MediaBox" => vec![0.into(), 0.into(), 40.into(), 40.into()],
        "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceCMYK" },
    });
    doc.set_object(
        pages,
        dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1,
        },
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    doc
}

fn render(scene: Scene, options: RenderOptions) -> PageRender {
    render_page(&fixture(scene), 1, 72., PageBox::Crop, options)
        .expect("Fixture process knockout phải dựng được, không bỏ đối tượng")
}

// Oracle ở miền ánh sáng cộng, đổi sang lượng mực sau cùng. Các nhánh không
// dùng BlendMode/helper trong production để tránh tự chứng minh chính mình.
fn blend_ink(mode: &str, backdrop: f64, source: f64) -> f64 {
    let b = 1. - backdrop;
    let s = 1. - source;
    let multiply_or_screen = |selector: f64| {
        if selector <= 0.5 {
            2. * b * s
        } else {
            1. - 2. * (1. - b) * (1. - s)
        }
    };
    let light = match mode {
        "Normal" => s,
        "Multiply" => b * s,
        "Screen" => b + s - b * s,
        "Overlay" => multiply_or_screen(b),
        "Darken" => b.min(s),
        "Lighten" => b.max(s),
        "ColorDodge" => {
            if b == 0. {
                0.
            } else if s == 1. {
                1.
            } else {
                (b / (1. - s)).min(1.)
            }
        }
        "ColorBurn" => {
            if b == 1. {
                1.
            } else if s == 0. {
                0.
            } else {
                1. - ((1. - b) / s).min(1.)
            }
        }
        "HardLight" => multiply_or_screen(s),
        "SoftLight" => {
            if s <= 0.5 {
                b - (1. - 2. * s) * b * (1. - b)
            } else {
                let d = if b <= 0.25 {
                    ((16. * b - 12.) * b + 4.) * b
                } else {
                    b.sqrt()
                };
                b + (2. * s - 1.) * (d - b)
            }
        }
        "Difference" => (b - s).abs(),
        "Exclusion" => b + s - 2. * b * s,
        _ => panic!("Oracle chưa khai phép hòa trộn {mode}"),
    };
    1. - light
}

fn shading_sample(kind: i64) -> [f64; 4] {
    // Pixel (20,20) ở PDF (20.5,19.5); LUT 256 mẫu lấy tâm gần nhất.
    let t = if kind == 2 {
        20.5 / 40.
    } else {
        (0.5f64 * 0.5 * 2.).sqrt() / 20.
    };
    let t = (t * 255.).round() / 255.;
    std::array::from_fn(|channel| FIRST[channel] + t * (LAST[channel] - FIRST[channel]))
}

fn expected_center(scene: Scene) -> [f64; 4] {
    expected_sample(scene, shading_sample(scene.kind))
}

fn expected_sample(scene: Scene, source: [f64; 4]) -> [f64; 4] {
    let alpha = scene.alpha * scene.mask.unwrap_or(1.);
    let shape = if scene.ais { alpha } else { 1. };
    std::array::from_fn(|channel| {
        // Hình học riêng của shading phủ kín pixel giữa. K dùng backdrop
        // ban đầu, không lấy sibling PREVIOUS làm nền cho blend.
        let blended = blend_ink(scene.blend, BACKDROP[channel], source[channel]);
        let result = (1. - shape) * PREVIOUS[channel]
            + (shape - alpha) * BACKDROP[channel]
            + alpha * blended;
        // Với ca tại boundary khác 1, fixture chỉ dùng shading opaque để
        // nguồn group độc lập với backdrop, kiểm phép merge đúng một lần.
        (1. - scene.boundary_alpha) * BACKDROP[channel]
            + scene.boundary_alpha * blend_ink(scene.boundary, BACKDROP[channel], result)
    })
}

fn assert_pixel(page: &PageRender, x: usize, y: usize, expected: [f64; 4], scene: Scene) {
    let index = y * page.buffer.width() as usize + x;
    for (channel, expected) in expected.into_iter().enumerate() {
        let actual = page.buffer.plane(channel)[index] as f64;
        assert!(
            (actual - expected).abs() < 3e-6,
            "{scene:?}, ({x},{y}), kênh{channel}: actual={actual}, expected={expected}"
        );
    }
    assert_eq!(
        page.warnings.dropped_objects, 0,
        "{scene:?}: {:?}",
        page.warnings
    );
}

fn scene(source: SourceSpace, kind: i64) -> Scene {
    Scene {
        kind,
        source,
        alpha: 0.5,
        ais: false,
        mask: None,
        blend: "Normal",
        boundary: "Normal",
        boundary_alpha: 1.,
    }
}

#[test]
fn process_devicen_axial_and_radial_keep_knockout_shape_at_zero_opacity() {
    for kind in [2, 3] {
        let scene = Scene {
            alpha: 0.,
            ..scene(SourceSpace::Cmy, kind)
        };
        let page = render(scene, RenderOptions::softproof());
        assert_pixel(&page, 20, 20, BACKDROP, scene);
        assert_pixel(&page, 7, 20, PREVIOUS, scene);
        assert_pixel(&page, 1, 20, BACKDROP, scene);
    }
}

#[test]
fn process_shading_matches_independent_knockout_oracle_across_ais_masks_and_blends() {
    for kind in [2, 3] {
        for alpha in [0., 0.5, 1.] {
            for ais in [false, true] {
                for mask in [None, Some(0.), Some(0.25), Some(1.)] {
                    for blend in MODES {
                        let mut reference = None;
                        for source in [SourceSpace::Cmyk, SourceSpace::Cmy] {
                            let scene = Scene {
                                alpha,
                                ais,
                                mask,
                                blend,
                                ..scene(source, kind)
                            };
                            let page = render(scene, RenderOptions::softproof());
                            assert_pixel(&page, 20, 20, expected_center(scene), scene);
                            assert_pixel(&page, 7, 20, PREVIOUS, scene);
                            assert_pixel(&page, 1, 20, BACKDROP, scene);
                            if let Some(previous) = reference.as_ref() {
                                let previous: &PageRender = previous;
                                for channel in 0..4 {
                                    for (left, right) in previous
                                        .buffer
                                        .plane(channel)
                                        .iter()
                                        .zip(page.buffer.plane(channel))
                                    {
                                        assert!((left - right).abs() < 3e-6,
                                            "CMYK/DeviceN lệch kênh{channel}: {scene:?}, {left}/{right}");
                                    }
                                }
                            }
                            reference = Some(page);
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn process_shading_group_separable_boundary_applies_opacity_once() {
    for kind in [2, 3] {
        for source in [SourceSpace::Cmyk, SourceSpace::Cmy] {
            for boundary_alpha in [0., 0.199997, 0.5, 1.] {
                for boundary in MODES {
                    let scene = Scene {
                        alpha: 1.,
                        boundary,
                        boundary_alpha,
                        ..scene(source, kind)
                    };
                    let page = render(scene, RenderOptions::softproof());
                    assert_pixel(&page, 20, 20, expected_center(scene), scene);
                    let expected_previous = std::array::from_fn(|channel| {
                        (1. - boundary_alpha) * BACKDROP[channel]
                            + boundary_alpha
                                * blend_ink(boundary, BACKDROP[channel], PREVIOUS[channel])
                    });
                    assert_pixel(&page, 7, 20, expected_previous, scene);
                    assert_pixel(&page, 1, 20, BACKDROP, scene);
                }
            }
        }
    }
}

fn guard_count(page: &PageRender) -> u32 {
    page.warnings
        .skipped_ops
        .iter()
        .filter(|(reason, _)| reason == "Group /K true (knockout)")
        .map(|(_, count)| *count)
        .sum()
}

#[test]
fn process_shading_without_ais_or_mask_receives_preview_certificate() {
    for kind in [2, 3] {
        for source in [SourceSpace::Cmyk, SourceSpace::Cmy] {
            for alpha in [0., 0.5, 1.] {
                for blend in MODES {
                    let scene = Scene {
                        alpha,
                        blend,
                        ..scene(source, kind)
                    };
                    let page = render(scene, RenderOptions::softproof());
                    assert_pixel(&page, 20, 20, expected_center(scene), scene);
                    assert_eq!(guard_count(&page), 0, "{scene:?}: {:?}", page.warnings);
                    assert!(
                        !page.warnings.ink_unsound(),
                        "{scene:?}: {:?}",
                        page.warnings
                    );
                }
            }
            for boundary in MODES {
                let scene = Scene {
                    alpha: 1.,
                    boundary,
                    boundary_alpha: 0.199997,
                    ..scene(source, kind)
                };
                let page = render(scene, RenderOptions::softproof());
                assert_pixel(&page, 20, 20, expected_center(scene), scene);
                assert_eq!(guard_count(&page), 0, "{scene:?}: {:?}", page.warnings);
                assert!(
                    !page.warnings.ink_unsound(),
                    "{scene:?}: {:?}",
                    page.warnings
                );
            }
        }
    }
}

#[test]
fn ais_and_soft_mask_numeric_support_receives_preview_certificate() {
    for kind in [2, 3] {
        for (ais, mask) in [(true, None), (false, Some(0.25)), (true, Some(0.25))] {
            let scene = Scene {
                ais,
                mask,
                ..scene(SourceSpace::Cmy, kind)
            };
            let page = render(scene, RenderOptions::softproof());
            assert_pixel(&page, 20, 20, expected_center(scene), scene);
            assert_eq!(guard_count(&page), 0, "{scene:?}: {:?}", page.warnings);
            assert!(!page.warnings.unsupported_transparency, "{scene:?}: {:?}", page.warnings);
        }
    }
}

#[test]
fn non_process_or_ambiguous_shading_remains_uncertified() {
    for source in [
        SourceSpace::Spot,
        SourceSpace::Mixed,
        SourceSpace::Duplicate,
        SourceSpace::Rgb,
    ] {
        for kind in [2, 3] {
            let scene = scene(source, kind);
            let page = render(scene, RenderOptions::softproof());
            assert!(
                page.warnings.unsupported_transparency && guard_count(&page) > 0,
                "{scene:?}: colorspace ngoài miền phải giữ guard: {:?}",
                page.warnings
            );
            assert_eq!(
                page.warnings.dropped_objects, 0,
                "{scene:?}: {:?}",
                page.warnings
            );
        }
    }
}

#[test]
fn process_shading_measurement_and_export_do_not_inherit_preview_certificate() {
    for options in [
        RenderOptions::default(),
        RenderOptions::ink_accurate(),
        RenderOptions::cmyk_export(),
    ] {
        let page = render(scene(SourceSpace::Cmy, 2), options);
        assert!(
            page.warnings.unsupported_transparency && guard_count(&page) > 0,
            "Đo/xuất mực chưa được nhận chứng nhận xem trước: {:?}",
            page.warnings
        );
    }
}

fn check_solid_path_matrix(stroke: bool) {
    for source in [SourceSpace::Cmyk, SourceSpace::Cmy] {
        for alpha in [0., 0.5, 1.] {
            for ais in [false, true] {
                for mask in [None, Some(0.), Some(0.25), Some(1.)] {
                    for blend in MODES {
                        let scene = Scene {
                            alpha,
                            ais,
                            mask,
                            blend,
                            ..scene(source, 2)
                        };
                        let document = fixture_with_path(scene, Some(stroke));
                        let page = render_page(
                            &document,
                            1,
                            72.,
                            PageBox::Crop,
                            RenderOptions::softproof(),
                        )
                        .expect("Mảng tô/nét process phải dựng được đầy đủ");
                        assert_pixel(&page, 20, 20, expected_sample(scene, FIRST), scene);
                        assert_pixel(&page, 7, 20, PREVIOUS, scene);
                        assert_pixel(&page, 1, 20, BACKDROP, scene);
                        assert_eq!(guard_count(&page), 0,
                            "Nét={stroke}, {scene:?}: {:?}", page.warnings);
                        assert!(!page.warnings.unsupported_transparency,
                            "Nét={stroke}, {scene:?}: {:?}", page.warnings);
                        assert!(!page.warnings.ink_unsound(),
                            "Nét={stroke}, {scene:?}: {:?}", page.warnings);
                    }
                }
            }
        }
    }
}

#[test]
fn process_devicen_solid_fill_matches_independent_knockout_oracle() {
    check_solid_path_matrix(false);
}

#[test]
fn process_devicen_stroke_matches_independent_knockout_oracle_and_uses_ca() {
    check_solid_path_matrix(true);
}

#[test]
fn ambiguous_process_names_do_not_certify_solid_fill_or_stroke() {
    for stroke in [false, true] {
        let document = fixture_with_path(scene(SourceSpace::Duplicate, 2), Some(stroke));
        let page = render_page(&document, 1, 72., PageBox::Crop, RenderOptions::softproof())
            .expect("Fixture tên process trùng phải trả guard");
        assert!(
            page.warnings.unsupported_transparency && guard_count(&page) > 0,
            "Tên process trùng không được nhận chứng nhận, nét={stroke}: {:?}",
            page.warnings
        );
    }
}
