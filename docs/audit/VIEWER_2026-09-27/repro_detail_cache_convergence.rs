//! Chẩn đoán V27.R: dùng trực tiếp source cache hiện tại, không sửa ứng dụng.
//! Texture chỉ giữ kích thước; không render PDF, không tạo cửa sổ hay input.
#[path = "../../../desktop/src-tauri/src/viewport/detail_cache.rs"]
mod detail_cache;

use detail_cache::DetailCache;
use print_engine::geom::Matrix;
use viewer_gpu::{resident_present::ResidentFrame, GpuContext};

fn frame(ctx: &GpuContext, matrix: Matrix, width: u32, height: u32) -> ResidentFrame {
    ResidentFrame {
        texture: ctx.create_target_texture(width, height, wgpu::TextureFormat::Rgba8Unorm, None),
        matrix,
    }
}

fn converge(ctx: &GpuContext, label: &str, source: Matrix, target: Matrix) -> bool {
    let (width, height) = (1292, 733);
    let mut cache = DetailCache::new(None);
    cache.insert(frame(ctx, source, width, height));
    let mut previous = None;
    for step in 0..32 {
        if cache.touch(target, width, height) {
            println!("{label} converged=true steps={step} entries={}", cache.len());
            return true;
        }
        let rect = cache.missing_region(target, width, height).unwrap_or([0, 0, width, height]);
        let [x, y, w, h] = rect;
        if step < 6 || previous == Some(rect) {
            println!("{label} step={step} region={rect:?} repeated={} entries={}", previous == Some(rect), cache.len());
        }
        cache.insert(frame(ctx, Matrix { e: target.e - x as f32, f: target.f - y as f32, ..target }, w, h));
        if previous == Some(rect) && !cache.touch(target, width, height) {
            println!("{label} converged=false repeated_region_after_insert={rect:?} entries={}", cache.len());
            return false;
        }
        previous = Some(rect);
    }
    println!("{label} converged=false reached_probe_iterations=32");
    false
}

fn main() {
    let ctx = GpuContext::new_sync().unwrap();
    assert!(converge(&ctx, "integer_control", Matrix::IDENTITY, Matrix::translate(-5., 3.)));

    // Camera tổng hợp gần trường hợp log; không giả vờ là replay matrix đầy đủ
    // vì telemetry camera/raster hiện tại đã làm tròn pan và không có tọa độ ROI.
    let scale = 6.377287864685059_f32;
    let source = Matrix::new(scale, 0., 0., -scale, -2980.15, 561.26 * scale - 1733.73);
    let target = Matrix { e: source.e - 5., f: source.f + 3., ..source };
    let fractional_converged = converge(&ctx, "fractional_pan", source, target);
    println!("fractional_identity_roundtrip={:?}", target.invert().unwrap().then(&target));

    // Phản ví dụ riêng: cùng matrix không đồng nghĩa cùng extent/độ phủ.
    let mut cache = DetailCache::new(None);
    cache.insert(frame(&ctx, Matrix::IDENTITY, 100, 100));
    assert!(cache.touch(Matrix::IDENTITY, 100, 100));
    cache.insert(frame(&ctx, Matrix::IDENTITY, 3, 5));
    let retained_full = cache.touch(Matrix::IDENTITY, 100, 100);
    println!("same_origin_small_crop retained_full={retained_full} entries={} bytes={}", cache.len(), cache.bytes());
    assert!(!retained_full, "Source đã đổi: phản ví dụ thay thế frame không còn tái hiện");
    println!("SUMMARY fractional_converged={fractional_converged} same_origin_coverage_loss={}", !retained_full);
}
