//! # PrynX Print Engine (PPE)
//!
//! Engine prepress clean-room, thay thế Ghostscript cho các đường **đo / xem**
//! của PrynX: tách kẽm (separations), TAC / ink-limit, soft-proof, overprint.
//!
//! ## Nguyên tắc thiết kế cốt lõi
//!
//! Khác mọi renderer thông dụng (pdfium/Skia/CoreGraphics) chạy trong RGB, PPE
//! rasterize **trực tiếp trong không gian mực** (ink space): một buffer n kênh
//! `[C, M, Y, K, spot1, spot2, …]`, mỗi kênh là lượng mực 0.0–1.0.
//!
//! Hệ quả — đây là lý do phải tự viết thay vì bọc pdfium:
//!
//! * **Spot color sống sót.** DeviceN/Separation giữ kênh riêng, không bị nén về
//!   alternate space. Plate Pantone là dữ liệu thật, không phải suy diễn.
//! * **Overprint là mô hình gốc, không phải mô phỏng.** Overprint = "không chạm
//!   vào kênh mà nguồn không khai báo" (ISO 32000-2 §11.7.4.2). Trong ink space
//!   đó là một dòng code; trong RGB thì không biểu diễn được.
//! * **TAC đo được đúng.** Tổng mực = tổng kênh tại từng điểm. Không phải suy ra
//!   từ pixel RGB đã mất thông tin.
//!
//! ## Ranh giới trách nhiệm
//!
//! PPE **chỉ đọc và raster**. Mọi đường ghi cấu trúc PDF vẫn là pikepdf ở lớp
//! Python (invariant sẵn có của repo). PPE không sinh PDF.
//!
//! ## Clean-room
//!
//! Implement từ ISO 32000-2 + spec ICC + so sánh output dạng black-box. Không
//! đọc, không port, không tham chiếu source Ghostscript / MuPDF / Poppler.

pub mod blend;
pub mod cancel;
pub mod color;
pub mod content;
pub mod error;
pub mod geom;
pub mod image;
pub mod ink;
pub mod oc;
pub mod page;
pub mod page_program;
pub mod pdf;
pub mod raster;
pub mod session;
pub mod shading;
pub mod text;

/// PERF (audit 2026-09-23 §R23.VECTOR): bộ đếm chẩn đoán của một process probe.
/// Timing là inclusive (end_path chứa color/coverage/composite), không cộng các
/// nhóm để suy tổng. Không compile vào bản mặc định hoặc tự bật trong app.
#[cfg(feature = "perf-probe")]
pub mod perf_probe {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static NANOS: [AtomicU64; 9] = [const { AtomicU64::new(0) }; 9];
    static CALLS: [AtomicU64; 9] = [const { AtomicU64::new(0) }; 9];
    pub const END_PATH: usize = 0;
    pub const PAINT_COLOR: usize = 1;
    pub const COVERAGE: usize = 2;
    pub const COMPOSITE: usize = 3;
    pub const COMPOSITE_RGB: usize = 4;
    pub const STATE: usize = 5;
    pub const PATH_BUILD: usize = 6;
    pub const GROUP_SETUP: usize = 7;
    pub const GROUP_FINISH: usize = 8;

    pub struct Span(usize, Instant);
    pub fn span(stage: usize) -> Span {
        Span(stage, Instant::now())
    }
    impl Drop for Span {
        fn drop(&mut self) {
            NANOS[self.0].fetch_add(self.1.elapsed().as_nanos() as u64, Ordering::Relaxed);
            CALLS[self.0].fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn reset() {
        for counter in NANOS.iter().chain(CALLS.iter()) {
            counter.store(0, Ordering::Relaxed);
        }
    }
    pub fn snapshot() -> Vec<(&'static str, u64, f64)> {
        ["end_path", "paint_color", "coverage", "composite", "composite_rgb",
         "state", "path_build", "group_setup", "group_finish"]
            .into_iter()
            .enumerate()
            .map(|(i, name)| (
                name,
                CALLS[i].load(Ordering::Relaxed),
                NANOS[i].load(Ordering::Relaxed) as f64 / 1_000_000.0,
            ))
            .collect()
    }

    #[test]
    fn span_records_monotonic_counter_without_changing_stage_layout() {
        reset();
        { let _span = span(PAINT_COLOR); }
        let snapshot = snapshot();
        assert_eq!(snapshot.len(), 9);
        assert_eq!(snapshot[PAINT_COLOR].0, "paint_color");
        assert!(snapshot[PAINT_COLOR].1 >= 1);
        assert!(snapshot[PAINT_COLOR].2.is_finite() && snapshot[PAINT_COLOR].2 >= 0.0);
    }
}

pub use blend::BlendMode;
pub use cancel::CancelToken;
pub use color::{ColorSpace, PdfFunction};
pub use content::{RenderOptions, Renderer};
pub use error::{PpeError, PpeResult, RenderWarnings};
pub use ink::{Colorant, InkBuffer, InkPaint, InkSpace};
pub use page::{render_page, PageRender};
pub use page_program::PageProgram;
pub use session::{
    DocumentIdentity, ProfileFileIdentity, ProfileIdentity, RenderSession, ResourceCacheStats,
    SessionIdentity, SharedRenderSession, SESSION_ENGINE_VERSION,
};
