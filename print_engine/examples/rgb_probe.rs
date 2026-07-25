//! Đo trực tiếp phép quy đổi RGB→CMYK của PPE trên các màu mốc.
//!
//! Công cụ chẩn đoán, không phải tính năng. Nó tồn tại vì khi PPE lệch Ghostscript
//! ở một trang RGB, câu hỏi phải trả lời là *"lệch ở phép biến đổi hay ở chỗ
//! khác"*, và cách duy nhất để biết là in ra chính con số của phép biến đổi.
//!
//! ```text
//! cargo run --release --example rgb_probe -- <FOGRA39.icc> [sRGB.icc]
//! ```
//!
//! In hai bảng: có và không bù điểm đen, để thấy cờ đó dịch tỉ lệ K/CMY bao nhiêu.

use std::path::Path;

use print_engine::color::{ColorManager, RenderIntent};

const PATCHES: &[(&str, [f32; 3])] = &[
    ("white", [1.0, 1.0, 1.0]),
    ("black", [0.0, 0.0, 0.0]),
    ("mid gray", [0.5, 0.5, 0.5]),
    ("red", [1.0, 0.0, 0.0]),
    ("green", [0.0, 1.0, 0.0]),
    ("blue", [0.0, 0.0, 1.0]),
    ("dark brown", [0.25, 0.15, 0.05]),
];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("dùng: rgb_probe <FOGRA39.icc> [sRGB.icc]");
        std::process::exit(2);
    }
    let cmyk = Path::new(&args[1]);
    let rgb = args.get(2).map(Path::new);

    for bpc in [true, false] {
        let mut cm = ColorManager::from_profiles(cmyk, rgb, RenderIntent::default())
            .expect("không mở được profile");
        cm.set_black_point_compensation(bpc);

        println!(
            "\n=== bù điểm đen: {} ===",
            if bpc { "BẬT" } else { "TẮT" }
        );
        println!("{:<12} {:>7} {:>7} {:>7} {:>7} {:>8}", "màu", "C%", "M%", "Y%", "K%", "TAC%");
        for (name, rgb_in) in PATCHES {
            match cm.rgb_to_cmyk(rgb_in[0], rgb_in[1], rgb_in[2]) {
                Some(c) => println!(
                    "{:<12} {:>7.1} {:>7.1} {:>7.1} {:>7.1} {:>8.1}",
                    name,
                    c[0] * 100.0,
                    c[1] * 100.0,
                    c[2] * 100.0,
                    c[3] * 100.0,
                    c.iter().sum::<f32>() * 100.0
                ),
                None => println!("{name:<12} (không quy đổi được)"),
            }
        }
    }
}
