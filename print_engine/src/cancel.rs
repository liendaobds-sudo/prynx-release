//! Tín hiệu hủy hợp tác cho một lần render PPE.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{PpeError, PpeResult};

/// Token nhẹ, có thể chia sẻ từ lớp điều phối tới các vòng raster nóng.
#[derive(Clone, Default)]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Trả `true` chỉ ở lần đầu chuyển token sang trạng thái đã hủy.
    pub fn cancel(&self) -> bool {
        !self.cancelled.swap(true, Ordering::AcqRel)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn check(&self) -> PpeResult<()> {
        if self.is_cancelled() {
            Err(PpeError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloned_token_observes_cancellation() {
        let token = CancelToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());

        assert!(token.cancel());
        assert!(!token.cancel());

        assert!(clone.is_cancelled());
        assert!(matches!(clone.check(), Err(PpeError::Cancelled)));
    }
}
