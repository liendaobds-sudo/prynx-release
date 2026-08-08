//! Đo riêng từng công đoạn soft-proof PPE trên một trang PDF thật.
//!
//! Chạy:
//! `cargo run --release --example softproof_bench -- <pdf> <cmyk.icc> [rgb.icc] [page] [dpi]`

use std::env;
use std::path::Path;
use std::time::Instant;

use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::page::{open, render_page_managed, PageBox};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        return Err("thiếu tham số: <pdf> <cmyk.icc> [rgb.icc] [page] [dpi]".into());
    }

    let pdf_path = &args[1];
    let cmyk_path = Path::new(&args[2]);
    let rgb_path = args.get(3).filter(|value| !value.is_empty()).map(Path::new);
    let page = args
        .get(4)
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(1);
    let dpi = args
        .get(5)
        .map(|value| value.parse::<f32>())
        .transpose()?
        .unwrap_or(36.0);

    let total_started = Instant::now();

    let started = Instant::now();
    let manager =
        ColorManager::from_profiles(cmyk_path, rgb_path, RenderIntent::RelativeColorimetric)?;
    let icc_ms = started.elapsed().as_secs_f64() * 1000.0;

    let started = Instant::now();
    let document = open(pdf_path)?;
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;

    let started = Instant::now();
    let rendered = render_page_managed(
        &document,
        page,
        dpi,
        PageBox::Crop,
        RenderOptions::softproof(),
        Some(&manager),
    )?;
    let render_ms = started.elapsed().as_secs_f64() * 1000.0;

    let started = Instant::now();
    let rgb = rendered
        .buffer
        .to_srgb(&manager)
        .ok_or("không chuyển được CMYK sang sRGB")?;
    let convert_ms = started.elapsed().as_secs_f64() * 1000.0;

    println!(
        "page={page} dpi={dpi:.2} size={}x{} icc_ms={icc_ms:.3} open_ms={open_ms:.3} \
         render_ms={render_ms:.3} convert_ms={convert_ms:.3} total_ms={:.3} rgb_bytes={}",
        rendered.buffer.width(),
        rendered.buffer.height(),
        total_started.elapsed().as_secs_f64() * 1000.0,
        rgb.len(),
    );
    Ok(())
}
