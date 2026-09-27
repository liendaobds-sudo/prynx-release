//! PPE Viewer GPU - Viewport Scheduler & Gesture Coalescing (Milestone G3.2)
//!
//! Bộ điều phối frame và gom sự kiện (Gesture Coalescing):
//! - Gom input thành một lần gửi frame nhưng giữ đúng thứ tự phép camera.
//! - Tích hợp mô hình vô hiệu hóa 4 cấp L0-L3 (InvalidationLevel).
//! - Giữ từng neo zoom và giới hạn zoom như khi xử lý input tuần tự.

use super::controller::ViewportController;
use print_engine::scene::invalidation::InvalidationLevel;
use std::time::Instant;

// UIUX (audit 2026-09-27 §V27.R8): zoom quanh hai neo khác nhau không giao
// hoán; tổng hệ số bằng một vẫn có thể dịch camera. Giữ thứ tự input để cả
// đổi neo, pan xen kẽ và chạm giới hạn zoom đều theo đúng controller.
#[derive(Debug)]
enum PendingGesture {
    Zoom {
        anchor_x: f32,
        anchor_y: f32,
        factor: f32,
    },
    Pan {
        dx: f32,
        dy: f32,
    },
}

/// Bo gom su kien tuong tac lien tuc va dieu phoi frame
#[derive(Debug)]
pub struct ViewportScheduler {
    /// Muc invalidation cao nhat dang cho xu ly
    pending_invalidation: Option<InvalidationLevel>,
    /// Chỉ gộp các pan kề nhau; không đổi thứ tự qua một neo zoom.
    pending_gestures: Vec<PendingGesture>,
    /// Nguồn zoom thực đang chờ, kể cả khi tích hệ số bằng một.
    has_pending_zoom: bool,
    /// Thoi diem render frame cuoi cung
    last_frame_instant: Instant,
    /// Tong so frame da render
    frame_count: u64,
}

impl Default for ViewportScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl ViewportScheduler {
    pub fn new() -> Self {
        Self {
            pending_invalidation: None,
            pending_gestures: Vec::new(),
            has_pending_zoom: false,
            last_frame_instant: Instant::now(),
            frame_count: 0,
        }
    }

    /// Yeu cau vo hieu hoa o mot cap cu the (L0 -> L3).
    /// Muc cao hon luon ghi de / uu tien hon muc thap hon.
    pub fn request_invalidation(&mut self, level: InvalidationLevel) {
        if let Some(current) = self.pending_invalidation {
            if level > current {
                self.pending_invalidation = Some(level);
            }
        } else {
            self.pending_invalidation = Some(level);
        }
    }

    /// Gom su kien cuon chuot (wheel zoom) vao frame hien tai
    pub fn accumulate_zoom(&mut self, anchor_x: f32, anchor_y: f32, factor: f32) {
        self.pending_gestures.push(PendingGesture::Zoom {
            anchor_x,
            anchor_y,
            factor,
        });
        self.has_pending_zoom = true;
        self.request_invalidation(InvalidationLevel::L0Camera);
    }

    /// Gom su kien keo re chuot (drag pan) vao frame hien tai
    pub fn accumulate_pan(&mut self, dx: f32, dy: f32) {
        if let Some(PendingGesture::Pan {
            dx: pending_x,
            dy: pending_y,
        }) = self.pending_gestures.last_mut()
        {
            *pending_x += dx;
            *pending_y += dy;
        } else {
            self.pending_gestures.push(PendingGesture::Pan { dx, dy });
        }
        self.request_invalidation(InvalidationLevel::L0Camera);
    }

    /// Kiem tra xem scheduler co yeu cau can re-render hay khong
    pub fn is_dirty(&self) -> bool {
        self.pending_invalidation.is_some() || !self.pending_gestures.is_empty()
    }

    /// Đọc trước consume để phân biệt input zoom thực với fit/resize hay pan.
    pub fn has_pending_zoom(&self) -> bool {
        self.has_pending_zoom
    }

    /// Muc invalidation cao nhat dang cho
    pub fn pending_level(&self) -> Option<InvalidationLevel> {
        self.pending_invalidation
    }

    /// Thuc thi va tieu thu (consume) toan bo delta tich luy len Controller truoc khi ve frame.
    /// Tra ve InvalidationLevel can ap dung cho pipeline, hoac None neu khong co gi thay doi.
    pub fn consume_pending(
        &mut self,
        controller: &mut ViewportController,
    ) -> Option<InvalidationLevel> {
        if !self.is_dirty() {
            return None;
        }

        // PERF (audit 2026-09-27 §V27.R8): drain giữ allocation cho frame sau,
        // không hard-cap hàng đợi hay bỏ input. Chỉ gửi frame sau khi đã replay.
        for gesture in self.pending_gestures.drain(..) {
            match gesture {
                PendingGesture::Zoom {
                    anchor_x,
                    anchor_y,
                    factor,
                } => {
                    controller.anchor_zoom(anchor_x, anchor_y, factor);
                }
                PendingGesture::Pan { dx, dy } => controller.pan(dx, dy),
            }
        }
        self.has_pending_zoom = false;

        self.last_frame_instant = Instant::now();
        self.frame_count = self.frame_count.wrapping_add(1);

        self.pending_invalidation.take()
    }

    /// Tong so frame da render
    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gesture_coalescing_zoom() {
        let mut scheduler = ViewportScheduler::new();
        let mut controller = ViewportController::new(1000, 1000, 1.0);

        // Gia lap nguoi dung cuon chuot 5 lan rat nhanh truoc khi co frame ve
        for _ in 0..5 {
            scheduler.accumulate_zoom(500.0, 500.0, 1.1);
        }

        assert!(scheduler.is_dirty());
        assert_eq!(scheduler.pending_level(), Some(InvalidationLevel::L0Camera));

        let level = scheduler.consume_pending(&mut controller);
        assert_eq!(level, Some(InvalidationLevel::L0Camera));

        // Zoom phai bang 1.1^5 ~ 1.61051
        let expected_zoom = 1.1_f32.powi(5);
        assert!((controller.zoom - expected_zoom).abs() < 1e-4);

        // Sau khi consume, scheduler phai tro ve trang thai sach
        assert!(!scheduler.is_dirty());
        assert_eq!(scheduler.pending_level(), None);
    }

    #[test]
    fn test_gesture_coalescing_pan() {
        let mut scheduler = ViewportScheduler::new();
        let mut controller = ViewportController::new(1000, 1000, 1.0);

        // Gia lap 10 su kien chuot di chuyen trong 1 frame
        for _ in 0..10 {
            scheduler.accumulate_pan(5.0, -3.0);
        }

        let level = scheduler.consume_pending(&mut controller);
        assert_eq!(level, Some(InvalidationLevel::L0Camera));

        assert!((controller.pan_x - 50.0).abs() < 1e-4);
        assert!((controller.pan_y - (-30.0)).abs() < 1e-4);
    }

    #[test]
    fn test_invalidation_level_precedence() {
        let mut scheduler = ViewportScheduler::new();
        let mut controller = ViewportController::new(1000, 1000, 1.0);

        // Yeu cau L0
        scheduler.request_invalidation(InvalidationLevel::L0Camera);
        assert_eq!(scheduler.pending_level(), Some(InvalidationLevel::L0Camera));

        // Yeu cau L2 ghi de len L0
        scheduler.request_invalidation(InvalidationLevel::L2ResourceProfile);
        assert_eq!(
            scheduler.pending_level(),
            Some(InvalidationLevel::L2ResourceProfile)
        );

        // Yeu cau L1 khong duoc ha cap L2 xuong
        scheduler.request_invalidation(InvalidationLevel::L1ViewState);
        assert_eq!(
            scheduler.pending_level(),
            Some(InvalidationLevel::L2ResourceProfile)
        );

        // Yeu cau L3 ghi de len L2
        scheduler.request_invalidation(InvalidationLevel::L3DocumentEdit);
        assert_eq!(
            scheduler.pending_level(),
            Some(InvalidationLevel::L3DocumentEdit)
        );

        let consumed = scheduler.consume_pending(&mut controller);
        assert_eq!(consumed, Some(InvalidationLevel::L3DocumentEdit));
    }

    #[test]
    fn test_anchor_zoom_stability_under_heavy_coalescing() {
        let mut scheduler = ViewportScheduler::new();
        let mut controller = ViewportController::new(1920, 1080, 1.0);

        let anchor = (960.0, 540.0);
        let scene_pt_before = controller.viewport_to_scene(anchor.0, anchor.1);

        // Cuon zoom vao 20 lan
        for _ in 0..20 {
            scheduler.accumulate_zoom(anchor.0, anchor.1, 1.05);
        }
        scheduler.consume_pending(&mut controller);

        // Cuon zoom ra 20 lan
        for _ in 0..20 {
            scheduler.accumulate_zoom(anchor.0, anchor.1, 1.0 / 1.05);
        }
        scheduler.consume_pending(&mut controller);

        let scene_pt_after = controller.viewport_to_scene(anchor.0, anchor.1);

        // Do lech vi tri phai cuc nho (<= 0.01 pixel)
        let drift_x = (scene_pt_after.0 - scene_pt_before.0).abs();
        let drift_y = (scene_pt_after.1 - scene_pt_before.1).abs();

        assert!(drift_x < 0.01, "Anchor drift X qua lon: {}", drift_x);
        assert!(drift_y < 0.01, "Anchor drift Y qua lon: {}", drift_y);
    }
}

#[cfg(test)]
#[path = "scheduler_regression_tests.rs"]
mod regression_tests;
