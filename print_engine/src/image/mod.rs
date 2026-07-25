//! Ảnh XObject: giải mã và lấy mẫu trong không gian mực.

pub mod filters;
pub mod sampler;

pub use filters::{decode_chain, ImageCodec, PredictorParams};
pub use sampler::{ImageSampler, SampledImage};
