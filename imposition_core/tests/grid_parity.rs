//! Parity giữa `imposition_core::grid` (Rust — nguồn chân lý) và bản TS
//! `desktop/src/lib/imposerEngine/NupGridSolver.solveOptimalNupLayout`.
//!
//! KIENTRUC (audit 2026-07-29 §B.1)
//!
//! Vì sao cần: cùng một thuật toán lưới N-up tồn tại ở 4 nơi (Rust core, wrapper PyO3,
//! fallback Python, và bản TS). Đường **xuất file** đã hợp nhất về Rust (Task 11), nhưng
//! bản TS vẫn còn sống và được `ProductAdvisor` gọi để trả lời "1 tờ mấy con" cho người
//! dùng — chính `NupGridSolver.ts` tự ghi trong docstring rằng nó ĐÃ drift (thiếu nhánh
//! 'ARROW' mà Rust có). Nếu tư vấn lệch với tờ in thật, thợ tin số sai rồi mới phát hiện
//! lúc bình.
//!
//! Cơ chế: một fixture JSON dùng chung. Test Rust này và test vitest
//! `NupGridSolver.parity.test.ts` cùng đối chiếu với fixture đó, nên parity được bảo đảm
//! bắc cầu mà KHÔNG cần gọi Rust từ vitest (vitest không có toolchain Rust).
//!
//! Chỉ phủ `strategy = "simple_auto"` — đó là strategy duy nhất `ProductAdvisor` dùng, và
//! là phần chung chắc chắn của hai bản. Các nhánh shape (`optimal_auto`) đã được ghi nhận
//! là chỉ còn trên đường legacy phía TS; mở rộng parity sang đó là việc riêng.
//!
//! Sinh lại fixture khi ĐỔI THUẬT TOÁN có chủ đích:
//!     PRYNX_BLESS_PARITY=1 cargo test --manifest-path imposition_core/Cargo.toml grid_parity
//! rồi soi diff trước khi commit (cùng chính sách với golden master).

use std::fs;
use std::path::PathBuf;

use imposition_core::grid::solve_optimal_layout;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Case {
    /// Mô tả để khi test đỏ biết ngay case nào (đơn vị: point).
    name: String,
    usable_w: f64,
    usable_h: f64,
    orig_w: f64,
    orig_h: f64,
    gap_x: f64,
    gap_y: f64,
    expected: Expected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Expected {
    total_items: usize,
    cols: usize,
    rows: usize,
    is_rotated: bool,
    /// Làm tròn 3 chữ số để hai ngôn ngữ không lệch vì biểu diễn f64.
    overall_width: f64,
    overall_height: f64,
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("grid_parity_simple_auto.json")
}

/// Bộ input phủ các tình huống hay gặp ở nhà in: tem nhỏ trên tờ lớn, khổ vừa khít,
/// trường hợp phải xoay 90° mới ăn được nhiều hơn, có gap, và các biên (không lọt nổi
/// một con).
fn cases() -> Vec<(&'static str, f64, f64, f64, f64, f64, f64)> {
    vec![
        // (name, usable_w, usable_h, orig_w, orig_h, gap_x, gap_y)
        ("A4 doc tren SRA3 ngang", 1247.24, 892.91, 595.28, 841.89, 0.0, 0.0),
        ("tem 50x30mm tren to 320x450mm", 907.09, 1275.59, 141.73, 85.04, 0.0, 0.0),
        ("tem 50x30mm co gap 3mm", 907.09, 1275.59, 141.73, 85.04, 8.5, 8.5),
        ("card 90x54mm tren A3", 841.89, 1190.55, 255.12, 153.07, 0.0, 0.0),
        ("xoay moi an duoc nhieu hon", 400.0, 100.0, 90.0, 45.0, 0.0, 0.0),
        ("vua khit khong con du", 300.0, 200.0, 100.0, 100.0, 0.0, 0.0),
        ("vua khit co gap lam mat mot cot", 300.0, 200.0, 100.0, 100.0, 5.0, 0.0),
        ("con lon hon to - khong lot noi", 100.0, 100.0, 150.0, 150.0, 0.0, 0.0),
        ("dung mot con duy nhat", 150.0, 150.0, 149.9, 149.9, 0.0, 0.0),
        ("to dai hep - bang decal", 2834.65, 141.73, 85.04, 85.04, 2.83, 2.83),
        ("gap lon hon con", 500.0, 500.0, 40.0, 40.0, 60.0, 60.0),
        ("hinh vuong - xoay khong doi gi", 600.0, 400.0, 70.0, 70.0, 3.0, 7.0),
    ]
}

fn compute(case: &(&'static str, f64, f64, f64, f64, f64, f64)) -> Expected {
    let result = solve_optimal_layout(case.1, case.2, case.3, case.4, case.5, case.6, "simple_auto", None);
    Expected {
        total_items: result.total_items,
        cols: result.cols,
        rows: result.rows,
        is_rotated: result.is_rotated,
        overall_width: round3(result.overall_width),
        overall_height: round3(result.overall_height),
    }
}

#[test]
fn fixture_parity_khop_ban_rust() {
    let path = fixture_path();

    let built: Vec<Case> = cases()
        .iter()
        .map(|case| Case {
            name: case.0.to_string(),
            usable_w: case.1,
            usable_h: case.2,
            orig_w: case.3,
            orig_h: case.4,
            gap_x: case.5,
            gap_y: case.6,
            expected: compute(case),
        })
        .collect();

    if std::env::var("PRYNX_BLESS_PARITY").as_deref() == Ok("1") {
        fs::create_dir_all(path.parent().unwrap()).expect("tao thu muc fixtures");
        let json = serde_json::to_string_pretty(&built).expect("serialize fixture");
        fs::write(&path, json + "\n").expect("ghi fixture");
        eprintln!("Da ghi lai fixture: {}", path.display());
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "Khong doc duoc fixture {}: {err}. Chay lai voi PRYNX_BLESS_PARITY=1 de sinh.",
            path.display()
        )
    });
    let saved: Vec<Case> = serde_json::from_str(&raw).expect("parse fixture");

    assert_eq!(
        saved.len(),
        built.len(),
        "So case trong fixture khac so case trong test — cap nhat fixture (PRYNX_BLESS_PARITY=1)"
    );

    for (saved_case, built_case) in saved.iter().zip(built.iter()) {
        assert_eq!(saved_case.name, built_case.name, "Thu tu case bi lech");
        assert_eq!(
            saved_case.expected, built_case.expected,
            "Case '{}': ban Rust khac fixture. Neu doi thuat toan co chu dich thi bless lai \
             fixture VA kiem ban TS (NupGridSolver.parity.test.ts) cung doi theo.",
            saved_case.name
        );
    }
}
