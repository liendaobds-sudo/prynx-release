//! Dump thống kê kẽm của một trang ra JSON — dùng để so golden với Ghostscript.
//!
//! ```text
//! cargo run --release --example plate_stats -- <file.pdf> <page> <dpi> [preview]
//! ```
//!
//! Mặc định chạy chế độ đo mực (không AA) để so đúng với GS `tiffsep` +
//! `-dUseFastColor=true -dGraphicsAlphaBits=1`. Thêm `preview` để so đường xem
//! trước có khử răng cưa.

use std::path::Path;

use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::page::{open, render_page_managed, PageBox};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("dùng: plate_stats <file.pdf> [page] [dpi] [preview|ink] [FOGRA39.icc]");
        std::process::exit(2);
    }
    let path = &args[1];
    let page: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let dpi: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(100.0);
    let preview = args.get(4).map(|s| s == "preview").unwrap_or(false);

    let opts = if preview {
        RenderOptions::default()
    } else {
        RenderOptions::ink_accurate()
    };

    // Đối số 5: ICC CMYK đích. Đối số 6 (tuỳ chọn): ICC RGB nguồn — chỉ định được
    // là cần thiết khi so golden, vì Ghostscript dùng profile RGB riêng của nó.
    let icc_path = args.get(5).filter(|s| !s.is_empty());
    let rgb_path = args.get(6).filter(|s| !s.is_empty());
    let manager = match icc_path {
        Some(p) => match ColorManager::from_profiles(
            Path::new(p),
            rgb_path.map(Path::new),
            RenderIntent::default(),
        ) {
            Ok(cm) => Some(cm),
            Err(e) => {
                println!("{{\"error\":\"{}\"}}", escape(&format!("{e}")));
                std::process::exit(1);
            }
        },
        None => None,
    };

    let doc = match open(path) {
        Ok(d) => d,
        Err(e) => {
            println!("{{\"error\":\"{}\"}}", escape(&format!("{e}")));
            std::process::exit(1);
        }
    };

    let rendered = match render_page_managed(
        &doc,
        page,
        dpi,
        PageBox::Crop,
        opts,
        manager.as_ref(),
    ) {
        Ok(r) => r,
        Err(e) => {
            println!("{{\"error\":\"{}\"}}", escape(&format!("{e}")));
            std::process::exit(1);
        }
    };

    let buf = &rendered.buffer;
    let mut plates = Vec::new();
    for (ch, colorant) in buf.space().colorants().iter().enumerate() {
        let plane = buf.plane(ch);
        let max = plane.iter().cloned().fold(0.0f32, f32::max);
        let mean = if plane.is_empty() {
            0.0
        } else {
            plane.iter().sum::<f32>() / plane.len() as f32
        };
        plates.push(format!(
            "{{\"name\":\"{}\",\"is_spot\":{},\"max_pct\":{:.3},\"mean_pct\":{:.4},\"coverage_pct\":{:.3}}}",
            escape(colorant.name()),
            colorant.is_spot(),
            max * 100.0,
            mean * 100.0,
            buf.plate_coverage_pct(ch)
        ));
    }

    let w = &rendered.warnings;
    println!(
        "{{\"engine\":\"ppe\",\"width\":{},\"height\":{},\"rotate\":{},\"max_tac_pct\":{:.3},\
\"degraded\":{},\"dropped_objects\":{},\"unsupported_transparency\":{},\
\"approximated_colorspaces\":[{}],\"colorspaces_used\":[{}],\"skipped_ops\":[{}],\"plates\":[{}]}}",
        buf.width(),
        buf.height(),
        rendered.rotate,
        buf.max_tac_percent(),
        w.degrades_accuracy(),
        w.dropped_objects,
        w.unsupported_transparency,
        w.approximated_colorspaces
            .iter()
            .map(|cs| format!("\"{}\"", escape(cs)))
            .collect::<Vec<_>>()
            .join(","),
        w.colorspaces_used
            .iter()
            .map(|cs| format!("\"{}\"", escape(cs)))
            .collect::<Vec<_>>()
            .join(","),
        w.skipped_ops
            .iter()
            .map(|(name, n)| format!("{{\"op\":\"{}\",\"count\":{}}}", escape(name), n))
            .collect::<Vec<_>>()
            .join(","),
        plates.join(",")
    );
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ")
}
