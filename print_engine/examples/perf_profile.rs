//! Profile theo pha cho đường PPE tách kẽm — dùng trong audit hiệu năng.
//!
//! ```text
//! cargo run --release --example perf_profile -- <file.pdf> [dpi] [repeats]
//! ```

use std::hint::black_box;
use std::time::Instant;

use print_engine::content::RenderOptions;
use print_engine::page::{open, render_page, PageBox};

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1_000.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("dùng: perf_profile <file.pdf> [dpi] [repeats]");
        std::process::exit(2);
    }
    let path = &args[1];
    let dpi = args
        .get(2)
        .and_then(|value| value.parse().ok())
        .unwrap_or(300.0);
    let repeats = args
        .get(3)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5)
        .max(1);

    let document = open(path).unwrap_or_else(|error| panic!("không mở được {path}: {error}"));
    let render_started = Instant::now();
    let rendered = render_page(
        &document,
        1,
        dpi,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
    )
    .unwrap_or_else(|error| panic!("không render được {path}: {error}"));
    let render_ms = elapsed_ms(render_started);
    let buffer = &rendered.buffer;

    let max_tac_started = Instant::now();
    let mut tac_checksum = 0.0f64;
    for _ in 0..repeats {
        tac_checksum += black_box(buffer.max_tac_percent()) as f64;
    }
    let max_tac_ms = elapsed_ms(max_tac_started);

    let plates_started = Instant::now();
    let mut plate_checksum = 0u64;
    for _ in 0..repeats {
        for channel in 0..buffer.space().len() {
            let plate = black_box(buffer.plate_u8(channel));
            plate_checksum = plate_checksum
                .wrapping_add(plate.len() as u64)
                .wrapping_add(plate.first().copied().unwrap_or(0) as u64)
                .wrapping_add(plate.last().copied().unwrap_or(0) as u64);
            plate_checksum = plate_checksum
                .wrapping_add(black_box(buffer.plate_coverage_pct(channel)).to_bits() as u64);
        }
    }
    let plates_ms = elapsed_ms(plates_started);

    let cmyk_started = Instant::now();
    let mut cmyk_checksum = 0u64;
    for _ in 0..repeats {
        let cmyk = black_box(buffer.to_process_cmyk());
        cmyk_checksum = cmyk_checksum
            .wrapping_add(cmyk.len() as u64)
            .wrapping_add(cmyk.first().copied().unwrap_or(0) as u64)
            .wrapping_add(cmyk.last().copied().unwrap_or(0) as u64);
    }
    let cmyk_ms = elapsed_ms(cmyk_started);

    println!(
        "{{\"width\":{},\"height\":{},\"channels\":{},\"repeats\":{},\"render_ms\":{:.3},\"max_tac_total_ms\":{:.3},\"plates_total_ms\":{:.3},\"process_cmyk_total_ms\":{:.3},\"tac_checksum\":{:.3},\"plate_checksum\":{},\"cmyk_checksum\":{}}}",
        buffer.width(),
        buffer.height(),
        buffer.space().len(),
        repeats,
        render_ms,
        max_tac_ms,
        plates_ms,
        cmyk_ms,
        tac_checksum,
        plate_checksum,
        cmyk_checksum,
    );
}
