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

pub mod color;
pub mod content;
pub mod error;
pub mod geom;
pub mod image;
pub mod ink;
pub mod page;
pub mod pdf;
pub mod raster;
pub mod text;

pub use color::{ColorSpace, PdfFunction};
pub use content::{RenderOptions, Renderer};
pub use error::{PpeError, PpeResult, RenderWarnings};
pub use ink::{Colorant, InkBuffer, InkPaint, InkSpace};
pub use page::{render_page, PageRender};
