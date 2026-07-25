//! Chữ: trạng thái text, bảng mã hoá, font, glyph.

pub mod encoding;
pub mod font;
pub mod state;

pub use font::{load_font, LoadedFont};
pub use state::{TextRenderMode, TextState};
