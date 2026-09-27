//! PERF (audit 2026-09-27 §V27.R4): policy dùng chung cho Presenter và test.
//! Cùng camera phải giảm vùng thiếu sau mỗi ROI. Nếu không, dựng full PPE
//! thay vì lặp vô hạn; frame tốt vẫn ở cache cho tới khi full frame sẵn sàng.
use super::super::detail_cache::DetailCache;
use print_engine::geom::Matrix;

#[derive(Debug, PartialEq)]
pub enum RefinementDecision {
    Idle,
    Render {
        region: Option<[u32; 4]>,
        recovering: bool,
    },
}

#[derive(Default)]
pub struct RefinementPolicy {
    target: Option<(Matrix, u32, u32)>,
    previous_missing: Option<f64>,
}

impl RefinementPolicy {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Chỉ gọi khi worker không còn bận, sau khi đã nhận/cất frame hoàn tất.
    pub fn plan(
        &mut self,
        cache: &mut DetailCache,
        matrix: Matrix,
        width: u32,
        height: u32,
        partial_allowed: bool,
    ) -> RefinementDecision {
        let target = (matrix, width, height);
        if self.target != Some(target) {
            self.target = Some(target);
            self.previous_missing = None;
        }
        if cache.touch(matrix, width, height) {
            self.previous_missing = None;
            return RefinementDecision::Idle;
        }
        let Some(missing) = cache.missing_detail(matrix, width, height) else {
            self.previous_missing = None;
            return RefinementDecision::Idle;
        };
        let recovering = partial_allowed
            && self
                .previous_missing
                .is_some_and(|area| missing.area >= area);
        self.previous_missing = Some(missing.area);
        RefinementDecision::Render {
            region: if partial_allowed && !recovering {
                missing.region
            } else {
                None
            },
            recovering,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use viewer_gpu::{resident_present::ResidentFrame, GpuContext};

    #[test]
    fn stalled_roi_recovers_full_without_clearing_good_frame() {
        let ctx = GpuContext::new_sync().unwrap();
        let mut cache = DetailCache::new(None);
        cache.insert(ResidentFrame {
            texture: ctx.create_target_texture(50, 100, wgpu::TextureFormat::Rgba8Unorm, None),
            matrix: Matrix::IDENTITY,
        });
        let mut policy = RefinementPolicy::default();
        assert_eq!(
            policy.plan(&mut cache, Matrix::IDENTITY, 100, 100, true),
            RefinementDecision::Render {
                region: Some([48, 0, 52, 100]),
                recovering: false
            }
        );
        // Giả lập crop bị loại/không thêm được coverage: không lặp ROI nữa.
        assert_eq!(
            policy.plan(&mut cache, Matrix::IDENTITY, 100, 100, true),
            RefinementDecision::Render {
                region: None,
                recovering: true
            }
        );
        assert_eq!(cache.len(), 1);
        cache.insert(ResidentFrame {
            texture: ctx.create_target_texture(100, 100, wgpu::TextureFormat::Rgba8Unorm, None),
            matrix: Matrix::IDENTITY,
        });
        for _ in 0..120 {
            assert_eq!(
                policy.plan(&mut cache, Matrix::IDENTITY, 100, 100, true),
                RefinementDecision::Idle
            );
        }
        policy.reset();
        assert_eq!(
            policy.plan(&mut cache, Matrix::translate(-1.25, 0.), 100, 100, true),
            RefinementDecision::Render {
                // R8: khác pha pixel nên cần raster mới, không giữ ảnh bilinear
                // như một vùng đã nét. Pan nguyên bên dưới vẫn tái dùng được.
                region: None,
                recovering: false
            }
        );
        policy.reset();
        assert_eq!(
            policy.plan(&mut cache, Matrix::translate(-1., 0.), 100, 100, true),
            RefinementDecision::Render { region: None, recovering: false }
        );
        policy.reset();
        assert_eq!(
            policy.plan(&mut cache, Matrix::translate(-60., 0.), 100, 100, true),
            RefinementDecision::Render { region: Some([38, 0, 62, 100]), recovering: false }
        );
    }

    #[test]
    fn cpu_backend_never_receives_a_partial_request() {
        let mut cache = DetailCache::new(None);
        let mut policy = RefinementPolicy::default();
        assert_eq!(
            policy.plan(&mut cache, Matrix::IDENTITY, 100, 100, false),
            RefinementDecision::Render {
                region: None,
                recovering: false
            }
        );
    }
}
