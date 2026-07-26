//! Dump thống kê kẽm của một trang ra JSON — dùng để so golden với Ghostscript.
//!
//! ```text
//! cargo run --release --example plate_stats -- <file.pdf> <page> <dpi> [preview]
//! ```
//!
//! Mặc định chạy chế độ đo mực (không AA) để so đúng với GS `tiffsep` +
//! `-dUseFastColor=true -dGraphicsAlphaBits=1`. Thêm `preview` để so đường xem
//! trước có khử răng cưa.
//!
//! Đối số 7 là **font thay thế** cho font không nhúng. Nó phải khớp với thứ mà
//! `backend/app/core/print_engine/facade.py` truyền vào ở đường chạy thật: bộ đo
//! chạy cấu hình khác cấu hình sản xuất thì con số nó cho ra không nói được gì về
//! sản phẩm. Trước đây thiếu đối số này, nên mọi trang chữ dùng font không nhúng
//! hiện ra là "chưa vẽ được" trong bảng đo dù ở sản xuất chúng vẫn được vẽ.

use std::path::Path;

use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::page::{open, render_page_managed, PageBox};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "dùng: plate_stats <file.pdf> [page] [dpi] [preview|ink] [FOGRA39.icc] \
[sRGB.icc] [fallback.ttf]"
        );
        std::process::exit(2);
    }
    let path = &args[1];
    let page: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let dpi: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(100.0);
    let preview = args.get(4).map(|s| s == "preview").unwrap_or(false);

    let base_opts = if preview {
        RenderOptions::default()
    } else {
        RenderOptions::ink_accurate()
    };
    // Đối số 7: font thay cho font không nhúng, phải khớp cấu hình sản xuất.
    let opts = match args.get(7).filter(|s| !s.is_empty()) {
        Some(p) => match std::fs::read(p) {
            Ok(data) => base_opts.with_fallback_font(std::sync::Arc::new(data)),
            Err(e) => {
                println!(
                    "{{\"error\":\"không đọc được font thay thế {}: {}\"}}",
                    escape(p),
                    escape(&format!("{e}"))
                );
                std::process::exit(1);
            }
        },
        None => base_opts,
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
\"degraded\":{},\"ink_unsound\":{},\"geometry_approximate\":{},\"substituted_fonts\":[{}],\
\"dropped_objects\":{},\"unsupported_transparency\":{},\"hidden_content_risk\":{},\
\"approximated_colorspaces\":[{}],\"colorspaces_used\":[{}],\"skipped_ops\":[{}],\"plates\":[{}]}}",
        buf.width(),
        buf.height(),
        rendered.rotate,
        buf.max_tac_percent(),
        w.degrades_accuracy(),
        // Hai trục riêng: bộ đo phải phân biệt được "thiếu mực" (loại kết quả) với
        // "hình xấp xỉ vì thay font" (vẫn dùng được cho TAC) — gộp lại thì bảng đo
        // không nói được điều gì hữu ích về trang chữ.
        w.ink_unsound(),
        w.geometry_approximate(),
        w.substituted_fonts
            .iter()
            .map(|f| format!("\"{}\"", escape(f)))
            .collect::<Vec<_>>()
            .join(","),
        w.dropped_objects,
        w.unsupported_transparency,
        w.hidden_content_risk,
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
