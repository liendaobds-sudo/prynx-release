//! `imposition_core` — nguồn chân lý DUY NHẤT cho phép toán bình bài.
//!
//! Thuần Rust: KHÔNG phụ thuộc `pyo3`, `tauri`, hay thư viện PDF.
//! Hai binding mỏng (`native/` cho PyO3, `src-tauri/` cho Tauri) bọc crate này;
//! hai assembler (pikepdf / pdf-lib) chỉ tiêu thụ kết quả tính sẵn.
//!
//! Cấu trúc module:
//!   - `model`        : structs/enums hợp đồng dữ liệu (Task 4)
//!   - `grid`         : grid solver N-up / guillotine (Task 5)
//!   - `shape`        : solver theo hình tem die-cut (Task 5)
//!   - `sticker`      : layout tem (hex/cluster/alt) (Task 5)
//!   - `nfp`          : no-fit-polygon nesting (Task 5)
//!   - `orchestrator` : sinh ứng viên layout (Task 5)
//!   - `assembler`    : tính placement tuyệt đối + mark coords (Task 5)
//!
//! Các module toán được điền dần ở Task 5; structs hợp đồng ở Task 4.

pub const CORE_NAME: &str = "imposition_core";

// Hợp đồng dữ liệu (Task 4). Các module toán điền ở Task 5.
pub mod assembler;
pub mod grid;
pub mod model;
pub mod nfp;
pub mod orchestrator;
pub mod ratio_stack;
pub mod shape;
pub mod sticker;

pub use model::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_builds() {
        assert_eq!(CORE_NAME, "imposition_core");
    }
}
