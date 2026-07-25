//! Tầng rasterize: biến hình học PDF thành **mặt nạ độ phủ**, không thành màu.
//!
//! Đây là ranh giới thiết kế quan trọng. `tiny-skia` chỉ được dùng để trả lời một
//! câu hỏi hình học: *"pixel này bị hình che bao nhiêu phần trăm?"*. Việc phần
//! trăm đó biến thành mực gì, chồng hay khoét kênh nào, do [`crate::ink`] quyết
//! định. Nhờ vậy engine không bị kéo về mô hình màu RGB của thư viện raster.

pub mod mask;

pub use mask::{FillRule, Rasterizer};
