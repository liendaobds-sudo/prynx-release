//! Lớp màu: phân giải colorspace PDF và quy màu nguồn về không gian mực.

pub mod convert;
pub mod function;
pub mod icc;
pub mod space;

pub use function::{parse_ps_program, PdfFunction, PsOp};
pub use icc::{ColorManager, RenderIntent};
pub use space::ColorSpace;
