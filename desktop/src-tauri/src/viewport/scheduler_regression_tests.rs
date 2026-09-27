// UIUX (audit 2026-09-27 §V27.R8): gom input không được thay đổi phép camera
// theo thứ tự thực. Oracle chạy chính controller, không dựng lại công thức zoom.
use super::{InvalidationLevel, ViewportController, ViewportScheduler};

#[derive(Clone, Copy)]
enum Gesture {
    Zoom { x: f32, y: f32, factor: f32 },
    Pan { dx: f32, dy: f32 },
}

fn camera(zoom: f32, pan: (f32, f32)) -> ViewportController {
    let mut camera = ViewportController::new(1812, 865, 1.0);
    camera.zoom = zoom;
    camera.pan_x = pan.0;
    camera.pan_y = pan.1;
    camera
}

fn apply_direct(controller: &mut ViewportController, gesture: Gesture) {
    match gesture {
        Gesture::Zoom { x, y, factor } => controller.anchor_zoom(x, y, factor),
        Gesture::Pan { dx, dy } => controller.pan(dx, dy),
    }
}

fn enqueue(scheduler: &mut ViewportScheduler, gesture: Gesture) {
    match gesture {
        Gesture::Zoom { x, y, factor } => scheduler.accumulate_zoom(x, y, factor),
        Gesture::Pan { dx, dy } => scheduler.accumulate_pan(dx, dy),
    }
}

fn sequential(zoom: f32, pan: (f32, f32), gestures: &[Gesture]) -> ViewportController {
    let mut controller = camera(zoom, pan);
    for gesture in gestures {
        apply_direct(&mut controller, *gesture);
    }
    controller
}

fn coalesced(
    zoom: f32,
    pan: (f32, f32),
    gestures: &[Gesture],
    events_per_frame: usize,
) -> ViewportController {
    let mut controller = camera(zoom, pan);
    let mut scheduler = ViewportScheduler::new();
    for chunk in gestures.chunks(events_per_frame) {
        for gesture in chunk {
            enqueue(&mut scheduler, *gesture);
        }
        assert_eq!(
            scheduler.consume_pending(&mut controller),
            Some(InvalidationLevel::L0Camera)
        );
        assert!(
            !scheduler.is_dirty(),
            "Input đã nhận phải được tiêu thụ hết"
        );
        let settled = controller.snapshot();
        assert_eq!(scheduler.consume_pending(&mut controller), None);
        assert_eq!(controller.snapshot(), settled, "Tick idle không đổi camera");
    }
    controller
}

fn assert_camera_eq(actual: &ViewportController, expected: &ViewportController, label: &str) {
    let drift_x = (actual.pan_x - expected.pan_x).abs();
    let drift_y = (actual.pan_y - expected.pan_y).abs();
    let drift_zoom = (actual.zoom - expected.zoom).abs();
    assert!(
        drift_x <= 0.01 && drift_y <= 0.01 && drift_zoom <= 0.00001,
        "{label}: camera gom khác camera tuần tự; Δx={drift_x}, Δy={drift_y}, \
         Δzoom={drift_zoom}; thực tế={:?}, kỳ vọng={:?}",
        actual.snapshot(),
        expected.snapshot()
    );
}

#[test]
fn moving_wheel_anchor_preserves_every_event_transform() {
    let gestures = [
        Gesture::Zoom {
            x: 100.0,
            y: 150.0,
            factor: 1.15,
        },
        Gesture::Zoom {
            x: 350.0,
            y: 350.0,
            factor: 1.15,
        },
    ];
    let expected = sequential(1.0, (0.0, 0.0), &gestures);
    let actual = coalesced(1.0, (0.0, 0.0), &gestures, gestures.len());
    // Chỉ lấy neo cuối làm lệch 43,125 px ở trục X trong đúng hai nấc wheel.
    assert_camera_eq(&actual, &expected, "Hai neo wheel khác nhau");
}

#[test]
fn inverse_zoom_at_different_anchors_is_not_an_identity_transform() {
    let gestures = [
        Gesture::Zoom {
            x: 100.0,
            y: 150.0,
            factor: 2.0,
        },
        Gesture::Zoom {
            x: 300.0,
            y: 350.0,
            factor: 0.5,
        },
    ];
    let expected = sequential(1.0, (0.0, 0.0), &gestures);
    assert_eq!(
        (expected.zoom, expected.pan_x, expected.pan_y),
        (1.0, 100.0, 100.0)
    );
    let actual = coalesced(1.0, (0.0, 0.0), &gestures, gestures.len());
    assert_camera_eq(&actual, &expected, "Tổng hệ số bằng một nhưng neo đã đổi");
}

#[test]
fn pan_before_zoom_is_not_reordered_after_zoom() {
    let gestures = [
        Gesture::Pan {
            dx: 40.0,
            dy: -20.0,
        },
        Gesture::Zoom {
            x: 350.0,
            y: 240.0,
            factor: 2.0,
        },
    ];
    let expected = sequential(1.0, (0.0, 0.0), &gestures);
    let actual = coalesced(1.0, (0.0, 0.0), &gestures, gestures.len());
    assert_camera_eq(&actual, &expected, "Pan trước zoom");
}

#[test]
fn zoom_before_pan_keeps_the_original_order() {
    let gestures = [
        Gesture::Zoom {
            x: 350.0,
            y: 240.0,
            factor: 2.0,
        },
        Gesture::Pan {
            dx: 40.0,
            dy: -20.0,
        },
    ];
    let expected = sequential(1.0, (0.0, 0.0), &gestures);
    let actual = coalesced(1.0, (0.0, 0.0), &gestures, gestures.len());
    assert_camera_eq(&actual, &expected, "Zoom trước pan");
}

#[test]
fn interleaved_pan_and_moving_anchor_zoom_matches_sequential_camera() {
    let gestures = [
        Gesture::Pan {
            dx: -24.0,
            dy: 18.0,
        },
        Gesture::Zoom {
            x: 1220.0,
            y: 320.0,
            factor: 1.15,
        },
        Gesture::Pan { dx: 11.0, dy: -7.0 },
        Gesture::Zoom {
            x: 1175.0,
            y: 355.0,
            factor: 1.15,
        },
        Gesture::Pan { dx: -30.0, dy: 2.0 },
    ];
    let expected = sequential(4.365672, (-1218.6187, -598.06085), &gestures);
    let actual = coalesced(
        4.365672,
        (-1218.6187, -598.06085),
        &gestures,
        gestures.len(),
    );
    assert_camera_eq(&actual, &expected, "Pan/zoom xen kẽ trong cùng frame");
}

#[test]
fn upper_zoom_limit_applies_before_a_reversing_wheel_event() {
    let gestures = [
        Gesture::Zoom {
            x: 300.0,
            y: 200.0,
            factor: 2.0,
        },
        Gesture::Zoom {
            x: 450.0,
            y: 325.0,
            factor: 0.5,
        },
    ];
    let expected = sequential(60.0, (-500.0, -250.0), &gestures);
    assert_eq!(expected.zoom, 32.0);
    let actual = coalesced(60.0, (-500.0, -250.0), &gestures, gestures.len());
    assert_camera_eq(&actual, &expected, "Chạm zoom 64 rồi quay lại");
}

#[test]
fn lower_zoom_limit_applies_before_a_reversing_wheel_event() {
    let gestures = [
        Gesture::Zoom {
            x: 300.0,
            y: 200.0,
            factor: 0.5,
        },
        Gesture::Zoom {
            x: 450.0,
            y: 325.0,
            factor: 2.0,
        },
    ];
    let expected = sequential(0.06, (250.0, 125.0), &gestures);
    assert_eq!(expected.zoom, 0.1);
    let actual = coalesced(0.06, (250.0, 125.0), &gestures, gestures.len());
    assert_camera_eq(&actual, &expected, "Chạm zoom 0,05 rồi quay lại");
}

#[test]
fn frame_partition_does_not_change_camera_with_moving_anchors_and_zoom_limits() {
    let gestures = [
        Gesture::Pan {
            dx: -24.0,
            dy: 18.0,
        },
        Gesture::Zoom {
            x: 100.0,
            y: 150.0,
            factor: 1.15,
        },
        Gesture::Zoom {
            x: 350.0,
            y: 350.0,
            factor: 1.15,
        },
        Gesture::Zoom {
            x: 700.0,
            y: 550.0,
            factor: 0.5,
        },
        Gesture::Pan { dx: 11.0, dy: -7.0 },
        Gesture::Zoom {
            x: 920.0,
            y: 515.0,
            factor: 0.0001,
        },
        Gesture::Zoom {
            x: 825.0,
            y: 450.0,
            factor: 2.0,
        },
        Gesture::Pan { dx: -30.0, dy: 2.0 },
    ];
    let expected = sequential(60.0, (-500.0, -250.0), &gestures);
    for events_per_frame in 1..=gestures.len() {
        let actual = coalesced(60.0, (-500.0, -250.0), &gestures, events_per_frame);
        assert_camera_eq(
            &actual,
            &expected,
            &format!("Gom {events_per_frame} input/frame"),
        );
    }
}

#[test]
fn pending_zoom_origin_survives_inverse_events_and_clears_after_consume() {
    let mut scheduler = ViewportScheduler::new();
    let mut controller = camera(1.0, (0.0, 0.0));
    assert!(!scheduler.has_pending_zoom());
    scheduler.accumulate_pan(4.0, -2.0);
    assert!(!scheduler.has_pending_zoom());
    scheduler.accumulate_zoom(100.0, 150.0, 2.0);
    scheduler.accumulate_zoom(300.0, 350.0, 0.5);
    scheduler.request_invalidation(InvalidationLevel::L3DocumentEdit);
    assert!(scheduler.has_pending_zoom());
    assert_eq!(
        scheduler.consume_pending(&mut controller),
        Some(InvalidationLevel::L3DocumentEdit)
    );
    assert!(!scheduler.has_pending_zoom());
    assert!(!scheduler.is_dirty());
    scheduler.request_invalidation(InvalidationLevel::L1ViewState);
    assert!(!scheduler.has_pending_zoom());
}

#[test]
fn input_buffer_reuses_allocation_and_only_coalesces_adjacent_pan() {
    let mut scheduler = ViewportScheduler::new();
    let mut controller = camera(1.0, (0.0, 0.0));
    for _ in 0..64 {
        scheduler.accumulate_pan(1.0, -0.5);
    }
    assert_eq!(scheduler.pending_gestures.len(), 1);
    scheduler.accumulate_zoom(100.0, 150.0, 1.15);
    scheduler.accumulate_pan(2.0, -1.0);
    scheduler.accumulate_pan(3.0, -2.0);
    assert_eq!(scheduler.pending_gestures.len(), 3);
    let capacity = scheduler.pending_gestures.capacity();
    scheduler.consume_pending(&mut controller);
    assert!(scheduler.pending_gestures.is_empty());
    assert_eq!(scheduler.pending_gestures.capacity(), capacity);
    scheduler.accumulate_pan(4.0, -2.0);
    scheduler.accumulate_zoom(300.0, 250.0, 0.5);
    assert_eq!(scheduler.pending_gestures.capacity(), capacity);
}
