//! Test tích hợp: dựng PDF thật rồi render, kiểm tra kẽm.
//!
//! Đây là tầng test quan trọng nhất của PPE. Unit test chứng minh từng công thức
//! đúng; chỉ test tích hợp mới chứng minh **chuỗi** parse → colorspace →
//! rasterize → trộn mực cho ra đúng kẽm mà xưởng nhận được.

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::color::space::OutputPreviewFilter;
use print_engine::content::RenderOptions;
use print_engine::page::{
    render_page, render_page_managed_region, PageBox, PageRender, RasterClip,
};

/// Dựng PDF một trang từ content stream + resources.
fn build_pdf(
    content: &str,
    resources: Dictionary,
    media: [f32; 4],
    rotate: Option<i32>,
) -> Document {
    let mut doc = Document::with_version("1.7");

    let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let resources_id = doc.add_object(resources);
    let pages_id = doc.new_object_id().0;
    let pages_object_id = (pages_id, 0);

    let mut page_dict = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_object_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![
            media[0].into(), media[1].into(), media[2].into(), media[3].into(),
        ],
    };
    if let Some(r) = rotate {
        page_dict.set("Rotate", Object::Integer(r as i64));
    }
    let page_id = doc.add_object(page_dict);

    doc.set_object(
        pages_object_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        },
    );

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_object_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

/// Render ở chế độ đo mực (không AA) trên khung 10x10 point.
fn render(content: &str, resources: Dictionary) -> PageRender {
    let doc = build_pdf(content, resources, [0.0, 0.0, 10.0, 10.0], None);
    render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn plate_named(r: &PageRender, name: &str) -> Option<usize> {
    r.buffer
        .space()
        .colorants()
        .iter()
        .position(|c| c.name() == name)
}

/// Điểm giữa trang, nơi mọi hình test đều phủ.
fn center(r: &PageRender) -> usize {
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    (h / 2) * w + w / 2
}

fn pixel_total_ink(r: &PageRender, x: usize, y: usize) -> usize {
    let index = y * r.buffer.width() as usize + x;
    (0..r.buffer.space().len())
        .map(|channel| r.buffer.plate_u8(channel)[index] as usize)
        .sum()
}

fn render_output_preview_filter(
    content: &str,
    resources: Dictionary,
    filter: OutputPreviewFilter,
) -> PageRender {
    let doc = build_pdf(content, resources, [0.0, 0.0, 10.0, 10.0], None);
    render_page(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::softproof().with_output_preview_filter(filter),
    )
    .expect("Output Preview synthetic phải render được")
}

fn assert_clip_matches_full_page(full: &PageRender, tile: &PageRender, clip: RasterClip) {
    assert_eq!(tile.buffer.width(), clip.width);
    assert_eq!(tile.buffer.height(), clip.height);
    assert_eq!(
        tile.buffer.space().colorants(),
        full.buffer.space().colorants()
    );
    for channel in 0..full.buffer.space().len() {
        let full_plate = full.buffer.plate_u8(channel);
        let tile_plate = tile.buffer.plate_u8(channel);
        for tile_y in 0..clip.height as usize {
            let full_start =
                (clip.y as usize + tile_y) * full.buffer.width() as usize + clip.x as usize;
            let full_end = full_start + clip.width as usize;
            let tile_start = tile_y * clip.width as usize;
            let tile_end = tile_start + clip.width as usize;
            assert_eq!(
                &tile_plate[tile_start..tile_end],
                &full_plate[full_start..full_end],
                "xoay {}, clip {clip:?}, kênh {channel}, hàng tile {tile_y} phải bằng crop full-page",
                full.rotate,
            );
        }
    }
}

fn assert_clip_stroke_aa_close(full: &PageRender, tile: &PageRender, clip: RasterClip) {
    assert_eq!(tile.buffer.width(), clip.width);
    assert_eq!(tile.buffer.height(), clip.height);
    let mut max_delta = 0u8;
    let mut total_delta = 0usize;
    let mut sample_count = 0usize;
    for channel in 0..full.buffer.space().len() {
        let full_plate = full.buffer.plate_u8(channel);
        let tile_plate = tile.buffer.plate_u8(channel);
        for tile_y in 0..clip.height as usize {
            for tile_x in 0..clip.width as usize {
                let full_index = (clip.y as usize + tile_y) * full.buffer.width() as usize
                    + clip.x as usize
                    + tile_x;
                let tile_index = tile_y * clip.width as usize + tile_x;
                let delta = tile_plate[tile_index].abs_diff(full_plate[full_index]);
                max_delta = max_delta.max(delta);
                total_delta += delta as usize;
                sample_count += 1;
            }
        }
    }
    let mean_delta = total_delta as f64 / sample_count as f64;
    assert!(
        max_delta <= 16 && mean_delta <= 0.25,
        "xoay {}, clip {clip:?}: sai số stroke AA max={max_delta}, mean={mean_delta:.4}",
        full.rotate,
    );
}

fn assert_tile_overlap_stroke_aa_close(
    first: &PageRender,
    first_clip: RasterClip,
    second: &PageRender,
    second_clip: RasterClip,
) {
    let x0 = first_clip.x.max(second_clip.x);
    let y0 = first_clip.y.max(second_clip.y);
    let x1 = (first_clip.x + first_clip.width).min(second_clip.x + second_clip.width);
    let y1 = (first_clip.y + first_clip.height).min(second_clip.y + second_clip.height);
    assert!(x0 < x1 && y0 < y1, "hai tile phải có vùng chồng lấn");

    let mut max_delta = 0u8;
    let mut total_delta = 0usize;
    let mut sample_count = 0usize;
    let mut differing_samples = 0usize;
    for channel in 0..first.buffer.space().len() {
        let first_plate = first.buffer.plate_u8(channel);
        let second_plate = second.buffer.plate_u8(channel);
        for global_y in y0..y1 {
            for global_x in x0..x1 {
                let first_index = (global_y - first_clip.y) as usize * first_clip.width as usize
                    + (global_x - first_clip.x) as usize;
                let second_index = (global_y - second_clip.y) as usize * second_clip.width as usize
                    + (global_x - second_clip.x) as usize;
                let delta = first_plate[first_index].abs_diff(second_plate[second_index]);
                max_delta = max_delta.max(delta);
                total_delta += delta as usize;
                sample_count += 1;
                differing_samples += usize::from(delta > 0);
            }
        }
    }
    let mean_delta = total_delta as f64 / sample_count as f64;
    // PERF (audit 2026-08-08 §RENDER.3): CTM cuối vẫn lưu f32 nên hai origin
    // tile có thể đổi quyết định scan-convert ở rất ít pixel biên của stroke.
    // Số đo bốn góc xoay: max 12/255, mean 0,011389, tối đa 24 mẫu khác.
    assert!(
        max_delta <= 12 && mean_delta <= 0.012 && differing_samples <= 24,
        "overlap xoay {}: sai số max={max_delta}, mean={mean_delta:.6}, khác={differing_samples}",
        first.rotate,
    );
}

#[test]
fn output_preview_source_filters_keep_only_the_declared_color_space() {
    // Bốn ô tách biệt: trên-trái Gray, trên-phải Spot, dưới-trái CMYK,
    // dưới-phải RGB. Lấy mẫu giữa ô để loại ảnh hưởng antialias ở biên.
    let content = concat!(
        "0 g 0 5 5 5 re f ",
        "/CS0 cs 1 scn 5 5 5 5 re f ",
        "1 0 0 0 k 0 0 5 5 re f ",
        "1 0 0 rg 5 0 5 5 re f",
    );
    let cases = [
        (OutputPreviewFilter::DeviceGray, (2usize, 2usize)),
        (OutputPreviewFilter::Spot, (7usize, 2usize)),
        (OutputPreviewFilter::DeviceCmyk, (2usize, 7usize)),
        (OutputPreviewFilter::DeviceRgb, (7usize, 7usize)),
    ];
    let samples = [(2usize, 2usize), (7, 2), (2, 7), (7, 7)];

    for (filter, expected) in cases {
        let rendered = render_output_preview_filter(
            content,
            spot_resources("PANTONE 485 C"),
            filter,
        );
        for sample in samples {
            let ink = pixel_total_ink(&rendered, sample.0, sample.1);
            if sample == expected {
                assert!(ink > 100, "{filter:?} phải giữ ô {sample:?}, ink={ink}");
            } else {
                assert_eq!(ink, 0, "{filter:?} không được giữ ô {sample:?}");
            }
        }
    }
}

#[test]
fn output_preview_filter_all_giu_nguyen_tung_byte_plate_mac_dinh() {
    let content = concat!(
        "0.1 0.2 0.3 0.4 k 0 0 5 10 re f ",
        "0.8 0.1 0.2 rg 5 0 5 10 re f",
    );
    let doc = build_pdf(content, dictionary! {}, [0.0, 0.0, 10.0, 10.0], None);
    let default = render_page(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::softproof(),
    )
    .expect("render mặc định phải thành công");
    let explicit_all = render_page(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::All),
    )
    .expect("Show=All phải thành công");

    assert_eq!(default.buffer.width(), explicit_all.buffer.width());
    assert_eq!(default.buffer.height(), explicit_all.buffer.height());
    assert_eq!(
        default.buffer.space().colorants(),
        explicit_all.buffer.space().colorants()
    );
    for channel in 0..default.buffer.space().len() {
        assert_eq!(
            default.buffer.plate_u8(channel),
            explicit_all.buffer.plate_u8(channel),
            "Show=All không được đổi byte kẽm {channel}",
        );
    }
}

#[test]
fn output_preview_line_art_filter_is_exclusive_on_a_path_only_page() {
    let content = "0 0 0 1 k 0 0 10 10 re f";
    let line_art = render_output_preview_filter(
        content,
        dictionary! {},
        OutputPreviewFilter::LineArt,
    );
    assert!(line_art.buffer.max_tac_percent() > 90.0);

    for filter in [
        OutputPreviewFilter::Text,
        OutputPreviewFilter::Images,
        OutputPreviewFilter::SmoothShades,
    ] {
        let hidden = render_output_preview_filter(content, dictionary! {}, filter);
        assert_eq!(hidden.buffer.max_tac_percent(), 0.0, "{filter:?} phải ẩn path");
    }
}

#[test]
fn viewport_clip_bang_crop_full_page_cho_moi_goc_xoay() {
    let content = concat!(
        "0.1 0.7 0.2 0.3 k 0 0 12 10 re f ",
        "0.8 0.1 0.6 0.2 k 2.25 1.75 7.5 5.5 re f",
    );
    for rotation in [0, 90, 180, 270] {
        let doc = build_pdf(
            content,
            dictionary! {},
            [0.0, 0.0, 12.0, 10.0],
            Some(rotation),
        );
        let full = render_page(&doc, 1, 144.0, PageBox::Crop, RenderOptions::softproof())
            .expect("full-page phải render được");
        let clips = [
            RasterClip {
                x: 3,
                y: 4,
                width: 13,
                height: 11,
            },
            RasterClip {
                x: 0,
                y: 0,
                width: 7,
                height: 6,
            },
            RasterClip {
                x: full.buffer.width() - 7,
                y: full.buffer.height() - 6,
                width: 7,
                height: 6,
            },
        ];

        for clip in clips {
            let tile = render_page_managed_region(
                &doc,
                1,
                144.0,
                PageBox::Crop,
                RenderOptions::softproof(),
                None,
                Some(clip),
            )
            .expect("viewport tile phải render được");

            assert_clip_matches_full_page(&full, &tile, clip);
        }
    }
}

#[test]
fn viewport_clip_giu_sai_so_stroke_aa_o_muc_khong_tao_seam() {
    let content = concat!(
        "0.1 0.7 0.2 0.3 k 0 0 12 10 re f ",
        "0 0 0 1 K 0.65 w 0.5 0.5 m 11.5 9.5 l S",
    );
    for rotation in [0, 90, 180, 270] {
        let doc = build_pdf(
            content,
            dictionary! {},
            [0.0, 0.0, 12.0, 10.0],
            Some(rotation),
        );
        let full = render_page(&doc, 1, 144.0, PageBox::Crop, RenderOptions::softproof())
            .expect("full-page phải render được");
        let clip = RasterClip {
            x: full.buffer.width() - 7,
            y: full.buffer.height() - 6,
            width: 7,
            height: 6,
        };
        let tile = render_page_managed_region(
            &doc,
            1,
            144.0,
            PageBox::Crop,
            RenderOptions::softproof(),
            None,
            Some(clip),
        )
        .expect("viewport tile có stroke phải render được");

        assert_clip_stroke_aa_close(&full, &tile, clip);
    }
}

#[test]
fn viewport_tiles_chong_lan_gioi_han_sai_so_stroke_aa() {
    let content = concat!(
        "0.1 0.7 0.2 0.3 k 0 0 100 80 re f ",
        "0 0 0 1 K 0.65 w ",
        "0.5 0.5 m 99.5 79.5 l S ",
        "0.5 79.5 m 99.5 0.5 l S",
    );
    let first_clip = RasterClip {
        x: 30,
        y: 30,
        width: 90,
        height: 80,
    };
    let second_clip = RasterClip {
        x: 60,
        y: 50,
        width: 80,
        height: 80,
    };

    for rotation in [0, 90, 180, 270] {
        let doc = build_pdf(
            content,
            dictionary! {},
            [0.0, 0.0, 100.0, 80.0],
            Some(rotation),
        );
        let first = render_page_managed_region(
            &doc,
            1,
            144.0,
            PageBox::Crop,
            RenderOptions::softproof(),
            None,
            Some(first_clip),
        )
        .expect("tile thứ nhất phải render được");
        let second = render_page_managed_region(
            &doc,
            1,
            144.0,
            PageBox::Crop,
            RenderOptions::softproof(),
            None,
            Some(second_clip),
        )
        .expect("tile thứ hai phải render được");

        assert_tile_overlap_stroke_aa_close(&first, first_clip, &second, second_clip);
    }
}

#[test]
fn viewport_clip_ngoai_trang_bi_tu_choi_truoc_cap_phat() {
    let doc = build_pdf(
        "0 0 0 1 k 0 0 10 10 re f",
        dictionary! {},
        [0.0, 0.0, 10.0, 10.0],
        None,
    );
    let result = render_page_managed_region(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::softproof(),
        None,
        Some(RasterClip {
            x: 9,
            y: 9,
            width: 2,
            height: 2,
        }),
    );

    assert!(matches!(
        result,
        Err(print_engine::PpeError::BadRasterClip { .. })
    ));
}

#[test]
fn viewport_clip_dpi_cao_khong_bi_chan_boi_dien_tich_full_page() {
    let doc = build_pdf(
        "0.2 0.4 0.6 0.1 k 0 0 595 842 re f",
        dictionary! {},
        [0.0, 0.0, 595.0, 842.0],
        None,
    );
    // A4 @960 DPI ≈ 89 MP: full-page vượt trần 80 MP nhưng tile 512² vẫn an toàn.
    assert!(render_page(&doc, 1, 960.0, PageBox::Crop, RenderOptions::softproof(),).is_err());

    let tile = render_page_managed_region(
        &doc,
        1,
        960.0,
        PageBox::Crop,
        RenderOptions::softproof(),
        None,
        Some(RasterClip {
            x: 7000,
            y: 9000,
            width: 512,
            height: 512,
        }),
    )
    .expect("viewport nhỏ phải render được dù full-page vượt 80 MP");
    assert_eq!((tile.buffer.width(), tile.buffer.height()), (512, 512));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mực process
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn solid_device_cmyk_fill_gives_exactly_400_percent_tac() {
    // Bài test chống false-clean quan trọng nhất: 4 kênh đặc PHẢI ra 400%.
    // Nếu ai đó chèn ICC hay AA vào đường đo mực, test này sẽ đỏ.
    let r = render("1 1 1 1 k 0 0 10 10 re f", dictionary! {});
    let i = center(&r);
    for ch in 0..4 {
        assert_eq!(r.buffer.plate_u8(ch)[i], 255, "kênh {ch} phải đặc");
    }
    assert!((r.buffer.max_tac_percent() - 400.0).abs() < 0.5);
}

#[test]
fn k_only_fill_leaves_cmy_plates_empty() {
    // Chữ đen K-only không được biến thành rich black.
    let r = render("0 0 0 1 k 0 0 10 10 re f", dictionary! {});
    let i = center(&r);
    assert_eq!(r.buffer.plate_u8(0)[i], 0, "Cyan phải trắng");
    assert_eq!(r.buffer.plate_u8(1)[i], 0);
    assert_eq!(r.buffer.plate_u8(2)[i], 0);
    assert_eq!(r.buffer.plate_u8(3)[i], 255, "Black phải đặc");
}

#[test]
fn device_gray_black_maps_to_k_only() {
    let r = render("0 g 0 0 10 10 re f", dictionary! {});
    let i = center(&r);
    assert_eq!(r.buffer.plate_u8(0)[i], 0);
    assert_eq!(r.buffer.plate_u8(3)[i], 255);
}

#[test]
fn half_tint_reads_as_half_ink() {
    let r = render("0 0 0 0.5 k 0 0 10 10 re f", dictionary! {});
    let v = r.buffer.plate_u8(3)[center(&r)];
    assert!((v as i32 - 128).abs() <= 1, "v={v}");
}

#[test]
fn unpainted_page_is_paper_white() {
    let r = render("", dictionary! {});
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Overprint / knockout — thứ RGB không làm được
// ─────────────────────────────────────────────────────────────────────────────

fn overprint_resources() -> Dictionary {
    dictionary! {
        "ExtGState" => dictionary! {
            "GSop" => dictionary! { "op" => true, "OP" => true, "OPM" => 1 },
        },
    }
}

#[test]
fn knockout_removes_background_ink_by_default() {
    // Mặc định PDF là knockout: hình đục đè lên sẽ khoét sạch mực nền.
    let r = render(
        "1 0 0 0 k 0 0 10 10 re f  0 0 0 1 k 0 0 10 10 re f",
        dictionary! {},
    );
    let i = center(&r);
    assert_eq!(r.buffer.plate_u8(0)[i], 0, "Cyan nền phải bị khoét");
    assert_eq!(r.buffer.plate_u8(3)[i], 255);
}

#[test]
fn overprint_preserves_background_ink() {
    // Cùng nội dung nhưng bật overprint: nền Cyan phải còn nguyên và TAC lên 200%.
    let r = render(
        "1 0 0 0 k 0 0 10 10 re f  /GSop gs 0 0 0 1 k 0 0 10 10 re f",
        overprint_resources(),
    );
    let i = center(&r);
    assert_eq!(r.buffer.plate_u8(0)[i], 255, "overprint phải giữ Cyan");
    assert_eq!(r.buffer.plate_u8(3)[i], 255);
    assert!((r.buffer.max_tac_percent() - 200.0).abs() < 0.5);
}

#[test]
fn overprint_preview_can_force_knockout_without_changing_pdf() {
    let content = "1 0 0 0 k 0 0 10 10 re f  /GSop gs 0 0 0 1 k 0 0 10 10 re f";
    let doc = build_pdf(content, overprint_resources(), [0.0, 0.0, 10.0, 10.0], None);
    let simulated = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render overprint phải thành công");
    let knockout = render_page(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_overprint_simulation(false),
    )
    .expect("render knockout phải thành công");
    assert_eq!(simulated.buffer.plate_u8(0)[center(&simulated)], 255);
    assert_eq!(knockout.buffer.plate_u8(0)[center(&knockout)], 0);
    assert_eq!(knockout.buffer.plate_u8(3)[center(&knockout)], 255);
}

/// Resource có cả kẽm mực pha lẫn ExtGState bật overprint.
fn spot_overprint_resources(name: &str) -> Dictionary {
    let mut res = spot_resources(name);
    res.set(
        "ExtGState",
        dictionary! {
            "GSop" => dictionary! { "op" => true, "OP" => true, "OPM" => 0 },
        },
    );
    res
}

#[test]
fn preview_space_keeps_spot_channel_so_overprint_is_visible() {
    // Hồi quy §A.1 (audit 2026-07-27): đường XEM từng quy mực pha về CMYK ngay lúc
    // dựng mực, nên object Pantone overprint và knockout cho kết quả GIỐNG NHAU và
    // Overprint Preview báo "không có vùng thay đổi" trên file có overprint thật.
    let content = "0 0 1 0 k 0 0 10 10 re f  /GSop gs /CS0 cs 1 scn 0 0 10 10 re f";
    let doc = build_pdf(
        content,
        spot_overprint_resources("PANTONE 877 C"),
        [0.0, 0.0, 10.0, 10.0],
        None,
    );

    let simulated = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::softproof())
        .expect("render overprint phải thành công");
    let knockout = render_page(
        &doc,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::softproof().with_overprint_simulation(false),
    )
    .expect("render knockout phải thành công");

    let spot = plate_named(&simulated, "PANTONE 877 C")
        .expect("đường xem vẫn phải cấp kênh riêng cho mực pha khi TRỘN");
    let i = center(&simulated);
    assert_eq!(simulated.buffer.plate_u8(spot)[i], 255);
    assert_eq!(
        simulated.buffer.plate_u8(2)[i],
        255,
        "overprint phải giữ Yellow nền"
    );
    assert_eq!(
        knockout.buffer.plate_u8(2)[i],
        0,
        "knockout phải khoét Yellow nền — đây là khác biệt mà preview phải thấy"
    );

    // Bảng CMYK tương đương phải được lấy mẫu, nếu không bước xuất ảnh sẽ hiện mực
    // pha thành đen thay vì màu của nó.
    let alt = simulated
        .buffer
        .space()
        .spot_alternate(spot)
        .expect("phải lấy mẫu tint transform của kẽm spot");
    let full = alt.cmyk_at(1.0);
    assert!((full[1] - 0.91).abs() < 0.01, "M ở tint 100%: {full:?}");
    assert!((full[2] - 0.76).abs() < 0.01, "Y ở tint 100%: {full:?}");
    let half = alt.cmyk_at(0.5);
    assert!((half[1] - 0.455).abs() < 0.02, "M ở tint 50%: {half:?}");
}

#[test]
fn measurement_space_does_not_sample_spot_alternates() {
    // Đường ĐO không cần bảng tra và không được trả thêm chi phí/cảnh báo vì nó.
    let r = render(
        "/CS0 cs 1 scn 0 0 10 10 re f",
        spot_resources("PANTONE 485 C"),
    );
    let spot = plate_named(&r, "PANTONE 485 C").expect("phải có kẽm spot");
    assert!(r.buffer.space().spot_alternate(spot).is_none());
}

#[test]
fn extgstate_op_alone_applies_to_both_fill_and_stroke() {
    // `/OP true` không kèm `/op` phải áp cho cả tô lẫn nét (§11.7.4.3).
    let res = dictionary! {
        "ExtGState" => dictionary! {
            "GS" => dictionary! { "OP" => true, "OPM" => 1 },
        },
    };
    let r = render(
        "1 0 0 0 k 0 0 10 10 re f  /GS gs 0 0 0 1 k 0 0 10 10 re f",
        res,
    );
    assert_eq!(r.buffer.plate_u8(0)[center(&r)], 255);
}

#[test]
fn constant_alpha_scales_ink() {
    let res = dictionary! {
        "ExtGState" => dictionary! { "GS" => dictionary! { "ca" => 0.5f32 } },
    };
    let r = render("/GS gs 0 0 0 1 k 0 0 10 10 re f", res);
    let v = r.buffer.plate_u8(3)[center(&r)];
    assert!((v as i32 - 128).abs() <= 2, "v={v}");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Spot color
// ─────────────────────────────────────────────────────────────────────────────

fn spot_resources(name: &str) -> Dictionary {
    // Separation với tint transform kiểu 2 về DeviceCMYK.
    let tint = dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        "C1" => vec![0.into(), 0.91f32.into(), 0.76f32.into(), 0.into()],
        "N" => 1,
        "Range" => vec![
            0.into(), 1.into(), 0.into(), 1.into(),
            0.into(), 1.into(), 0.into(), 1.into(),
        ],
    };
    dictionary! {
        "ColorSpace" => dictionary! {
            "CS0" => vec![
                "Separation".into(),
                Object::Name(name.as_bytes().to_vec()),
                "DeviceCMYK".into(),
                Object::Dictionary(tint),
            ],
        },
    }
}

#[test]
fn spot_color_produces_its_own_plate() {
    // Đây là lý do tồn tại của cả engine: kẽm Pantone phải là dữ liệu thật.
    let r = render(
        "/CS0 cs 1 scn 0 0 10 10 re f",
        spot_resources("PANTONE 485 C"),
    );
    let spot = plate_named(&r, "PANTONE 485 C").expect("phải có kẽm spot");
    let i = center(&r);
    assert_eq!(r.buffer.plate_u8(spot)[i], 255);
    for ch in 0..4 {
        assert_eq!(
            r.buffer.plate_u8(ch)[i],
            0,
            "spot KHÔNG được rơi sang kẽm process {ch}"
        );
    }
}

#[test]
fn spot_name_with_hash_escape_is_decoded() {
    // `/PANTONE#20485#20C` phải ra "PANTONE 485 C", nếu không việc so tên kênh
    // bế (CutContour…) ở lớp trên sẽ trượt.
    let r = render(
        "/CS0 cs 1 scn 0 0 10 10 re f",
        spot_resources("PANTONE#20485#20C"),
    );
    assert!(plate_named(&r, "PANTONE 485 C").is_some());
}

#[test]
fn spot_tint_half_gives_half_ink_on_spot_plate() {
    let r = render(
        "/CS0 cs 0.5 scn 0 0 10 10 re f",
        spot_resources("PANTONE 485 C"),
    );
    let spot = plate_named(&r, "PANTONE 485 C").unwrap();
    let v = r.buffer.plate_u8(spot)[center(&r)];
    assert!((v as i32 - 128).abs() <= 1, "v={v}");
}

#[test]
fn separation_named_cyan_does_not_create_fifth_plate() {
    let r = render("/CS0 cs 1 scn 0 0 10 10 re f", spot_resources("Cyan"));
    assert_eq!(r.buffer.space().len(), 4, "không được sinh kẽm spot Cyan");
    assert_eq!(r.buffer.plate_u8(0)[center(&r)], 255);
}

#[test]
fn separation_none_paints_nothing() {
    // Kênh /None hay dùng cho ghi chú kỹ thuật — tuyệt đối không được lên kẽm.
    let r = render("/CS0 cs 1 scn 0 0 10 10 re f", spot_resources("None"));
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert_eq!(r.buffer.space().len(), 4);
}

#[test]
fn devicen_splits_components_to_separate_plates() {
    let tint = dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        "C1" => vec![1.into(), 1.into(), 0.into(), 0.into()],
        "N" => 1,
        "Range" => vec![
            0.into(), 1.into(), 0.into(), 1.into(),
            0.into(), 1.into(), 0.into(), 1.into(),
        ],
    };
    let res = dictionary! {
        "ColorSpace" => dictionary! {
            "CS0" => vec![
                "DeviceN".into(),
                Object::Array(vec!["Cyan".into(), "Varnish".into()]),
                "DeviceCMYK".into(),
                Object::Dictionary(tint),
            ],
        },
    };
    let r = render("/CS0 cs 0.25 0.75 scn 0 0 10 10 re f", res);
    let i = center(&r);
    let varnish = plate_named(&r, "Varnish").expect("phải có kẽm Varnish");
    assert!((r.buffer.plate_u8(0)[i] as i32 - 64).abs() <= 2, "Cyan sai");
    assert!(
        (r.buffer.plate_u8(varnish)[i] as i32 - 191).abs() <= 2,
        "Varnish sai"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hình học
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn fill_respects_rectangle_bounds() {
    // Tô nửa trái: nửa phải phải trắng.
    let r = render("0 0 0 1 k 0 0 5 10 re f", dictionary! {});
    let w = r.buffer.width() as usize;
    let row = (r.buffer.height() as usize / 2) * w;
    assert_eq!(r.buffer.plate_u8(3)[row + 1], 255, "trong hình");
    assert_eq!(r.buffer.plate_u8(3)[row + w - 1], 0, "ngoài hình");
}

#[test]
fn clip_limits_subsequent_fill() {
    let r = render("0 0 5 10 re W n  0 0 0 1 k 0 0 10 10 re f", dictionary! {});
    let w = r.buffer.width() as usize;
    let row = (r.buffer.height() as usize / 2) * w;
    assert_eq!(r.buffer.plate_u8(3)[row + 1], 255, "trong clip");
    assert_eq!(
        r.buffer.plate_u8(3)[row + w - 1],
        0,
        "ngoài clip phải trắng"
    );
}

#[test]
fn clip_is_restored_by_q_and_uppercase_q() {
    // Clip đặt trong q…Q không được rò ra ngoài.
    let r = render(
        "q 0 0 2 10 re W n Q  0 0 0 1 k 0 0 10 10 re f",
        dictionary! {},
    );
    let w = r.buffer.width() as usize;
    let row = (r.buffer.height() as usize / 2) * w;
    assert_eq!(
        r.buffer.plate_u8(3)[row + w - 1],
        255,
        "clip đã phục hồi nên toàn trang phải được tô"
    );
}

#[test]
fn cm_translation_moves_the_shape() {
    let r = render("1 0 0 1 5 0 cm 0 0 0 1 k 0 0 5 10 re f", dictionary! {});
    let w = r.buffer.width() as usize;
    let row = (r.buffer.height() as usize / 2) * w;
    assert_eq!(r.buffer.plate_u8(3)[row + 1], 0, "bên trái phải trắng");
    assert_eq!(
        r.buffer.plate_u8(3)[row + w - 1],
        255,
        "hình đã dịch sang phải"
    );
}

#[test]
fn stroke_paints_ink() {
    let r = render("0 0 0 1 K 2 w 0 5 m 10 5 l S", dictionary! {});
    assert!(r.buffer.max_tac_percent() > 0.0, "nét phải lên mực");
}

#[test]
fn hairline_stroke_survives_rasterization() {
    // Đường bế cực mảnh: mất nét trên kẽm là lỗi chết người ở khâu bế.
    let r = render("0 0 0 1 K 0.01 w 0 5 m 10 5 l S", dictionary! {});
    assert!(
        r.buffer.max_tac_percent() > 0.0,
        "hairline không được biến mất"
    );
}

#[test]
fn even_odd_fill_creates_hole() {
    let r = render("0 0 0 1 k 0 0 10 10 re 3 3 4 4 re f*", dictionary! {});
    assert_eq!(
        r.buffer.plate_u8(3)[center(&r)],
        0,
        "even-odd phải để lỗ ở giữa"
    );
}

#[test]
fn rotate_90_swaps_raster_dimensions() {
    let doc = build_pdf(
        "0 0 0 1 k 0 0 10 20 re f",
        dictionary! {},
        [0.0, 0.0, 10.0, 20.0],
        Some(90),
    );
    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert_eq!(r.rotate, 90);
    assert_eq!((r.buffer.width(), r.buffer.height()), (20, 10));
}

#[test]
fn form_xobject_is_drawn_with_its_matrix() {
    let form_content = b"0 0 0 1 k 0 0 5 10 re f".to_vec();
    let mut doc = Document::with_version("1.7");
    let form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 5.into(), 0.into()],
        },
        form_content,
    ));
    let resources = dictionary! {
        "XObject" => dictionary! { "Fm0" => Object::Reference(form_id) },
    };
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"/Fm0 Do".to_vec()));
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

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    let w = r.buffer.width() as usize;
    let row = (r.buffer.height() as usize / 2) * w;
    // Matrix dịch +5 ⇒ hình 0..5 nằm ở nửa PHẢI.
    assert_eq!(r.buffer.plate_u8(3)[row + 1], 0);
    assert_eq!(r.buffer.plate_u8(3)[row + w - 1], 255);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trung thực về giới hạn (fail loud)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn text_is_reported_as_unrendered_instead_of_silently_dropped() {
    // Chưa vẽ text là chấp nhận được ở milestone này; báo "sạch" thì không.
    let r = render("BT /F1 12 Tf 1 1 Td (Hello) Tj ET", dictionary! {});
    assert!(r.warnings.degrades_accuracy());
    assert!(r.warnings.dropped_objects > 0);
}

#[test]
fn image_xobject_now_paints_ink() {
    // Trước milestone ảnh, test này khẳng định điều ngược lại (ảnh bị bỏ + ghi
    // nhận). Giữ lại ở đây để chốt rằng trang chỉ có ảnh KHÔNG còn ra trắng.
    let mut doc = Document::with_version("1.7");
    let img_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image",
            "Width" => 1, "Height" => 1, "BitsPerComponent" => 8,
            "ColorSpace" => "DeviceGray",
        },
        vec![0u8],
    ));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(img_id) },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"/Im0 Do".to_vec()));
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

    let r = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();
    assert_eq!(r.warnings.dropped_objects, 0, "ảnh gray 8-bit phải vẽ được");
    // Ảnh 1x1 DeviceGray giá trị 0 = đen ⇒ K đặc trên vùng ảnh chiếm.
    assert!(
        r.buffer.max_tac_percent() > 0.0,
        "trang chỉ có ảnh không được ra trắng"
    );
}

#[test]
fn shading_operator_with_missing_resource_is_reported() {
    // `sh` luôn tô một vùng. Không tìm được shading nghĩa là **mất nội dung**, nên
    // bỏ qua im lặng sẽ để lại khoảng trắng mà báo cáo vẫn nói trang sạch.
    let r = render("/Sh0 sh", dictionary! {});
    assert!(r.warnings.dropped_objects > 0);
    assert!(
        r.warnings
            .skipped_ops
            .iter()
            .any(|(op, _)| op.contains("/Shading")),
        "{:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn rgb_fill_is_flagged_as_approximate() {
    let r = render("1 0 0 rg 0 0 10 10 re f", dictionary! {});
    assert!(
        r.warnings.degrades_accuracy(),
        "RGB→CMYK không ICC phải bị đánh dấu xấp xỉ"
    );
}

#[test]
fn clean_cmyk_page_is_not_flagged() {
    // Ngược lại: trang CMYK thuần vẽ đủ thì KHÔNG được hạ accuracy oan.
    let r = render("0 0 0 1 k 0 0 10 10 re f", dictionary! {});
    assert!(!r.warnings.degrades_accuracy(), "{:?}", r.warnings);
}

#[test]
fn unbalanced_restore_does_not_break_rendering() {
    let r = render("Q Q 0 0 0 1 k 0 0 10 10 re f", dictionary! {});
    assert_eq!(r.buffer.plate_u8(3)[center(&r)], 255, "vẫn phải vẽ được");
}

#[test]
fn page_out_of_range_is_an_error() {
    let doc = build_pdf("", dictionary! {}, [0.0, 0.0, 10.0, 10.0], None);
    assert!(render_page(&doc, 5, 72.0, PageBox::Crop, RenderOptions::default()).is_err());
}

#[test]
fn anti_alias_mode_softens_edges_while_ink_mode_does_not() {
    let doc = build_pdf(
        "0 0 0 1 k 0 0 5.5 10 re f",
        dictionary! {},
        [0.0, 0.0, 10.0, 10.0],
        None,
    );
    let aa = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::default()).unwrap();
    let ink = render_page(&doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate()).unwrap();

    let has_partial = |r: &PageRender| r.buffer.plane(3).iter().any(|v| *v > 0.001 && *v < 0.999);
    assert!(has_partial(&aa), "chế độ xem trước phải có AA");
    assert!(!has_partial(&ink), "chế độ đo mực phải nhị phân");
}
