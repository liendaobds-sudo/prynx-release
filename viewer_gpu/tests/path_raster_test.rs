//! Integration tests cho GPU Vector Path Rasterizer & Coverage Pipeline (Milestone G2.2)
//!
//! Kiem tra:
//! 1. Vector rectangle fill truc tiep len intermediate texture Rgba16Float tren GPU
//! 2. Color resolve pass xuat ket qua ra sRGB target
//! 3. Duong cong Bezier analytical AA (Loop-Blinn)
//! 4. Ve nhieu doi tuong vector chong len nhau voi alpha blending

use viewer_gpu::{
    push_quadratic_bezier_vertices, push_rect_vertices, ColorResolvePipeline, GpuContext,
    PathRasterPipeline, PathUniforms, ResolveUniforms,
};

#[test]
fn test_gpu_vector_rectangle_raster_and_resolve() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU that bai");
    let width = 100u32;
    let height = 100u32;

    // 1. Tao intermediate texture Rgba16Float (chua CMYK)
    let intermediate = ctx.create_intermediate_texture(width, height, Some("Intermediate_CMYK"));
    let intermediate_view = intermediate.create_view(&wgpu::TextureViewDescriptor::default());

    // 2. Tao target texture Rgba8Unorm (hien thi)
    let target = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Target_Display"),
    );
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

    // 3. Chuan bi hinh chu nhat Magenta [0, 1, 0, 0] tai (10, 10), kich thuoc 50x50
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    push_rect_vertices(
        &mut vertices,
        &mut indices,
        10.0,
        10.0,
        50.0,
        50.0,
        [0.0, 1.0, 0.0, 0.0], // Magenta
        1.0,
    );

    let path_pipeline = PathRasterPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let path_uniforms = PathUniforms {
        viewport_width: width as f32,
        viewport_height: height as f32,
        device_scale: 1.0,
        _pad: 0.0,
    };

    // Rasterize vector len intermediate texture
    path_pipeline.render(
        &ctx.device,
        &ctx.queue,
        &intermediate_view,
        &vertices,
        &indices,
        &path_uniforms,
        true, // clear background
    );

    // 4. Color resolve sang target display texture
    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);
    resolve_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &intermediate_view,
        &target_view,
        &ResolveUniforms::default(),
    );

    // 5. Doc lai pixel tu GPU
    let pixels = ctx
        .readback_texture_rgba8(&target, width, height)
        .expect("Readback that bai");

    let get_pixel = |x: u32, y: u32| -> (u8, u8, u8) {
        let idx = ((y * width + x) * 4) as usize;
        (pixels[idx], pixels[idx + 1], pixels[idx + 2])
    };

    // Pixel nam trong hinh chu nhat (30, 30): phai la Magenta (R=255, G=0, B=255)
    let (in_r, in_g, in_b) = get_pixel(30, 30);
    assert!(in_r >= 250, "Inside R phai bang 255 (thuc te: {in_r})");
    assert!(in_g <= 5, "Inside G phai bang 0 (thuc te: {in_g})");
    assert!(in_b >= 250, "Inside B phai bang 255 (thuc te: {in_b})");

    // Pixel nam ngoai hinh chu nhat (80, 80): phai la mau trang giay (R=255, G=255, B=255)
    let (out_r, out_g, out_b) = get_pixel(80, 80);
    assert!(out_r >= 250, "Outside R phai bang 255 (thuc te: {out_r})");
    assert!(out_g >= 250, "Outside G phai bang 255 (thuc te: {out_g})");
    assert!(out_b >= 250, "Outside B phai bang 255 (thuc te: {out_b})");
}

#[test]
fn test_gpu_quadratic_bezier_curve_rasterization() {
    let ctx = GpuContext::new_sync().expect("Khoi tao GPU that bai");
    let width = 64u32;
    let height = 64u32;

    let intermediate = ctx.create_intermediate_texture(width, height, Some("Intermediate_Curve"));
    let intermediate_view = intermediate.create_view(&wgpu::TextureViewDescriptor::default());

    let target = ctx.create_target_texture(
        width,
        height,
        wgpu::TextureFormat::Rgba8Unorm,
        Some("Target_Curve"),
    );
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

    // Duong cong Bezier bac 2 (Loop-Blinn) voi mau Cyan [1, 0, 0, 0]
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    push_quadratic_bezier_vertices(
        &mut vertices,
        &mut indices,
        (0.0, 0.0),
        (32.0, 0.0),
        (64.0, 64.0),
        [1.0, 0.0, 0.0, 0.0], // Cyan
        1.0,
    );

    let path_pipeline = PathRasterPipeline::new(&ctx.device, wgpu::TextureFormat::Rgba16Float);
    let path_uniforms = PathUniforms {
        viewport_width: width as f32,
        viewport_height: height as f32,
        device_scale: 1.0,
        _pad: 0.0,
    };

    path_pipeline.render(
        &ctx.device,
        &ctx.queue,
        &intermediate_view,
        &vertices,
        &indices,
        &path_uniforms,
        true,
    );

    let resolve_pipeline = ColorResolvePipeline::new(&ctx.device, wgpu::TextureFormat::Rgba8Unorm);
    resolve_pipeline.execute(
        &ctx.device,
        &ctx.queue,
        &intermediate_view,
        &target_view,
        &ResolveUniforms::default(),
    );

    let pixels = ctx
        .readback_texture_rgba8(&target, width, height)
        .expect("Readback that bai");

    // Co it nhat mot so pixel Cyan (R=0, G=255, B=255) duoc tao thanh
    let cyan_pixel_count = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let idx = ((y * width + x) * 4) as usize;
            pixels[idx] <= 50 && pixels[idx + 1] >= 200 && pixels[idx + 2] >= 200
        })
        .count();

    assert!(
        cyan_pixel_count > 0,
        "Duong cong Bezier phai rasterize ra cac pixel Cyan tren GPU"
    );
}
