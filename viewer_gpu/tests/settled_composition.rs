//! PERF (audit 2026-09-27 §V27.R8): kiểm pixel cuối sau compositor thật,
//! không lấy việc cache đủ coverage hay texture ROI đúng làm bằng chứng đã nét.
//! Toàn bộ target là texture ngoài màn hình; không tạo HWND hoặc gửi input.

use std::sync::Arc;

use lopdf::{dictionary, Document, Stream};
use print_engine::{
    color::{icc::ColorManager, RenderIntent},
    content::RenderOptions,
    geom::Matrix,
    scene::retained::RetainedPage,
};
use viewer_gpu::{
    resident_present::{ResidentCompositor, ResidentFrame},
    retained_renderer::RetainedRenderer,
    GpuContext,
};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 96;

fn fixture() -> (Arc<RetainedPage>, ColorManager) {
    fixture_at(WIDTH, HEIGHT, 0., 0.)
}

fn fixture_at(
    page_width: u32,
    page_height: u32,
    origin_x: f32,
    origin_y: f32,
) -> (Arc<RetainedPage>, ColorManager) {
    let mut doc = Document::with_version("1.7");
    let pages = doc.new_object_id();
    // Nét dưới một pixel và đường cong có coverage phân số. Raster ở 1,5×
    // rồi bilinear về 1× không tương đương dựng trực tiếp trên lưới 1×.
    let mut operators = format!(
        "q 1 0 0 1 {origin_x} {origin_y} cm \
         0 0 0 1 K 0.37 w 6.2 10.15 m 118.4 81.65 l S \
         0.63 w 9.35 69.15 m 24.7 8.35 73.65 90.2 116.8 17.55 c S \
         1 0 0 0 k 31.25 21.4 m 41.8 61.35 87.65 12.2 95.15 70.7 c \
         77.35 48.1 54.6 70.35 31.25 21.4 c f \
         0 1 0 0 K 0.29 w 12.125 44.375 m 112.875 44.375 l S ",
    );
    for i in 0..14 {
        let x = 9.2 + i as f32 * 3.7;
        operators.push_str(&format!("0 0 0 1 K 0.41 w {x:.3} 13.3 m {x:.3} 35.7 l S "));
    }
    operators.push_str("Q");
    let contents = doc.add_object(Stream::new(dictionary! {}, operators.into_bytes()));
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), page_width.into(), page_height.into()],
        "Contents" => contents, "Resources" => dictionary! {},
    });
    doc.objects.insert(
        pages,
        dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1}.into(),
    );
    let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
    doc.trailer.set("Root", catalog);
    let color = ColorManager::from_cmyk_profile(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../backend/app/assets/icc/FOGRA39.icc"),
        RenderIntent::RelativeColorimetric,
    )
    .unwrap();
    let scene =
        Arc::new(RetainedPage::compile(&doc, 1, RenderOptions::viewer(), Some(&color)).unwrap());
    (scene, color)
}

fn render(
    ctx: &GpuContext,
    renderer: &RetainedRenderer,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    matrix: Matrix,
) -> ResidentFrame {
    let texture = ctx.create_target_texture(width, height, format, Some("R8 raster đối chứng"));
    renderer
        .render(
            ctx,
            &texture.create_view(&Default::default()),
            width,
            height,
            matrix,
        )
        .unwrap();
    ResidentFrame { texture, matrix }
}

fn composite(
    ctx: &GpuContext,
    compositor: &ResidentCompositor,
    format: wgpu::TextureFormat,
    matrix: Matrix,
    overview: &ResidentFrame,
    details: &[&ResidentFrame],
) -> Vec<u8> {
    let target = ctx.create_target_texture(WIDTH, HEIGHT, format, Some("R8 pixel cuối"));
    let mut commands = ctx.device.create_command_encoder(&Default::default());
    compositor
        .encode_layers(
            ctx,
            &mut commands,
            &target.create_view(&Default::default()),
            matrix,
            overview,
            details,
            WIDTH,
            HEIGHT,
        )
        .unwrap();
    ctx.queue.submit([commands.finish()]);
    // Với BGRA, hai vế cùng format nên đối chiếu byte không cần đổi thứ tự kênh.
    ctx.readback_texture_rgba8(&target, WIDTH, HEIGHT).unwrap()
}

fn difference(actual: &[u8], expected: &[u8], interior_only: bool) -> (usize, u8) {
    assert_eq!(actual.len(), expected.len());
    let mut different = 0;
    let mut largest = 0;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            if interior_only && (x < 8 || x >= WIDTH - 8 || y < 8 || y >= HEIGHT - 8) {
                continue;
            }
            let start = ((y * WIDTH + x) * 4) as usize;
            for channel in 0..4 {
                let delta = actual[start + channel].abs_diff(expected[start + channel]);
                different += usize::from(delta != 0);
                largest = largest.max(delta);
            }
        }
    }
    (different, largest)
}

#[test]
fn newest_exact_camera_frame_wins_over_older_denser_raster() {
    let ctx = GpuContext::new_sync().unwrap();
    let (scene, color) = fixture();
    let mut mismatches = Vec::new();
    for format in [
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureFormat::Bgra8UnormSrgb,
    ] {
        let renderer = RetainedRenderer::new(&ctx, scene.clone(), &color, format).unwrap();
        let compositor = ResidentCompositor::new(&ctx, format);
        let current = scene.page_to_view(1., 0., 0.);
        let overview = render(
            &ctx,
            &renderer,
            format,
            WIDTH / 2,
            HEIGHT / 2,
            scene.page_to_view(0.5, 0., 0.),
        );
        let old_dense = render(
            &ctx,
            &renderer,
            format,
            WIDTH * 3 / 2,
            HEIGHT * 3 / 2,
            scene.page_to_view(1.5, 0., 0.),
        );
        let exact = render(&ctx, &renderer, format, WIDTH, HEIGHT, current);
        let expected = ctx
            .readback_texture_rgba8(&exact.texture, WIDTH, HEIGHT)
            .unwrap();
        let exact_only = composite(&ctx, &compositor, format, current, &overview, &[&exact]);
        let exact_difference = difference(&exact_only, &expected, false);
        assert_eq!(
            exact_difference,
            (0, 0),
            "Đối chứng {format:?}: compositor với riêng frame đúng camera phải giữ nguyên byte"
        );

        // Cache trả entry từ cũ tới mới. Frame mới là raster đúng camera hiện
        // hành, không được bị frame cũ lấy mẫu lại đè lên chỉ vì mật độ cao hơn.
        let layered = composite(
            &ctx,
            &compositor,
            format,
            current,
            &overview,
            &[&old_dense, &exact],
        );
        let delta = difference(&layered, &expected, false);
        println!(
            "SETTLED_COMPOSITION format={format:?} exact_only_different_bytes={} layered_different_bytes={} max_channel_delta={}",
            exact_difference.0, delta.0, delta.1,
        );
        if delta.0 != 0 {
            mismatches.push(format!(
                "{format:?}: {} byte khác, delta tối đa {}",
                delta.0, delta.1
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "Frame cũ che raster đúng camera mới: {}",
        mismatches.join("; ")
    );
}

#[test]
fn current_grid_at_fractional_zoom_and_large_pan_keeps_exact_pixel_centers() {
    let ctx = GpuContext::new_sync().unwrap();
    let mut mismatches = Vec::new();
    for (name, page_width, page_height, origin_x, origin_y, pan_x, pan_y) in [
        ("fractional-pan", WIDTH, HEIGHT, 0., 0., -291.375, -182.625),
        ("large-pan", 2048, 1536, 1700., 1300., -9408.375, -976.375),
        (
            "poster-large-pan",
            14400,
            10800,
            13000.,
            10000.,
            -70068.125,
            -3988.125,
        ),
    ] {
        let (scene, color) = fixture_at(page_width, page_height, origin_x, origin_y);
        for format in [
            wgpu::TextureFormat::Rgba8Unorm,
            wgpu::TextureFormat::Bgra8UnormSrgb,
        ] {
            let renderer = RetainedRenderer::new(&ctx, scene.clone(), &color, format).unwrap();
            let compositor = ResidentCompositor::new(&ctx, format);
            let scale = 5.37;
            let current = scene.page_to_view(scale, pan_x, pan_y);
            let overview = render(
                &ctx,
                &renderer,
                format,
                WIDTH,
                HEIGHT,
                scene.page_to_view(WIDTH as f32 / page_width as f32, 0., 0.),
            );
            // Cùng vùng nhìn nhưng mật độ cao hơn; không cấp full-page texture
            // hàng trăm MB chỉ để kiểm phép map của camera có tọa độ lớn.
            let old_dense = render(
                &ctx,
                &renderer,
                format,
                WIDTH * 3 / 2,
                HEIGHT * 3 / 2,
                scene.page_to_view(scale * 1.5, pan_x * 1.5, pan_y * 1.5),
            );
            let exact = render(&ctx, &renderer, format, WIDTH, HEIGHT, current);
            let expected = ctx
                .readback_texture_rgba8(&exact.texture, WIDTH, HEIGHT)
                .unwrap();
            assert!(
                expected
                    .chunks_exact(4)
                    .any(|pixel| pixel != &expected[..4]),
                "Fixture phải có nét thật trong viewport, không chỉ màu nền: {name}"
            );
            let exact_only = composite(&ctx, &compositor, format, current, &overview, &[&exact]);
            let layered = composite(
                &ctx,
                &compositor,
                format,
                current,
                &overview,
                &[&old_dense, &exact],
            );
            let direct_delta = difference(&exact_only, &expected, false);
            let layered_delta = difference(&layered, &expected, false);
            println!("EXACT_GRID_MAPPING format={format:?} camera={name} exact_only_different_bytes={} exact_only_max_delta={} layered_different_bytes={} layered_max_delta={}",
                direct_delta.0, direct_delta.1, layered_delta.0, layered_delta.1);
            if direct_delta.0 != 0 || layered_delta.0 != 0 {
                mismatches.push(format!(
                    "{format:?}/{name}: exact={direct_delta:?}, layered={layered_delta:?}"
                ));
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "Roundtrip ma trận làm lệch tâm pixel đúng lưới: {}",
        mismatches.join("; ")
    );
}

#[test]
fn current_grid_crop_keeps_resampled_detail_outside_its_extent() {
    let ctx = GpuContext::new_sync().unwrap();
    let (scene, color) = fixture();
    for format in [
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureFormat::Bgra8UnormSrgb,
    ] {
        let renderer = RetainedRenderer::new(&ctx, scene.clone(), &color, format).unwrap();
        let compositor = ResidentCompositor::new(&ctx, format);
        let current = scene.page_to_view(1., 0., 0.);
        let overview = render(
            &ctx,
            &renderer,
            format,
            WIDTH / 2,
            HEIGHT / 2,
            scene.page_to_view(0.5, 0., 0.),
        );
        let old_dense = render(
            &ctx,
            &renderer,
            format,
            WIDTH * 3 / 2,
            HEIGHT * 3 / 2,
            scene.page_to_view(1.5, 0., 0.),
        );
        let full = render(&ctx, &renderer, format, WIDTH, HEIGHT, current);
        let full_pixels = ctx
            .readback_texture_rgba8(&full.texture, WIDTH, HEIGHT)
            .unwrap();
        let [x, y, width, height] = [16u32, 12, 96, 64];
        let texture = ctx.create_target_texture(width, height, format, Some("R8 crop đúng lưới"));
        let mut copy = ctx.device.create_command_encoder(&Default::default());
        copy.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &full.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        ctx.queue.submit([copy.finish()]);
        let crop = ResidentFrame {
            texture,
            matrix: Matrix {
                e: current.e - x as f32,
                f: current.f - y as f32,
                ..current
            },
        };
        let mut expected = composite(&ctx, &compositor, format, current, &overview, &[&old_dense]);
        for row in y..y + height {
            let start = ((row * WIDTH + x) * 4) as usize;
            let end = start + width as usize * 4;
            expected[start..end].copy_from_slice(&full_pixels[start..end]);
        }
        let actual = composite(
            &ctx,
            &compositor,
            format,
            current,
            &overview,
            &[&old_dense, &crop],
        );
        assert_eq!(
            difference(&actual, &expected, false),
            (0, 0),
            "{format:?}: crop mới chỉ thay pixel trong đúng extent, không xóa detail cũ ở ngoài"
        );
    }
}

#[test]
fn display_only_bilinear_reuse_does_not_certify_settled_pixels() {
    let ctx = GpuContext::new_sync().unwrap();
    let (scene, color) = fixture();
    for format in [
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureFormat::Bgra8UnormSrgb,
    ] {
        let renderer = RetainedRenderer::new(&ctx, scene.clone(), &color, format).unwrap();
        let compositor = ResidentCompositor::new(&ctx, format);
        let overview = render(
            &ctx,
            &renderer,
            format,
            WIDTH / 2,
            HEIGHT / 2,
            scene.page_to_view(0.5, 0., 0.),
        );
        let old = render(
            &ctx,
            &renderer,
            format,
            WIDTH,
            HEIGHT,
            scene.page_to_view(1., 0., 0.),
        );
        for (name, scale, pan_x, pan_y) in [
            ("pan-quarter", 1., 0.25, 0.),
            ("pan-half", 1., 0., 0.5),
            ("zoom-105", 1.05, -2.125, -1.375),
            ("zoom-110", 1.1, -4.25, -2.75),
        ] {
            let matrix = scene.page_to_view(scale, pan_x, pan_y);
            let exact = render(&ctx, &renderer, format, WIDTH, HEIGHT, matrix);
            let expected = ctx
                .readback_texture_rgba8(&exact.texture, WIDTH, HEIGHT)
                .unwrap();
            let displayed = composite(&ctx, &compositor, format, matrix, &overview, &[&old]);
            let delta = difference(&displayed, &expected, true);
            // Đây là quan sát về lớp dùng tạm khi tương tác, không bắt lớp
            // bilinear phải bằng raster mới và không tạo fail-gate cho nó.
            println!(
                "DISPLAY_ONLY_REUSE format={format:?} camera={name} interior_different_bytes={} max_channel_delta={} not_a_settled_proof=true",
                delta.0, delta.1,
            );
        }
    }
}
