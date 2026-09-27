//! PPE Viewer GPU - Native Viewport Controller (Milestone G3.1)
//!
//! Quan ly Camera Native, thuat toan Anchor Zoom (diem neo co dinh),
//! tinh toan toa do 4 cap theo Schema v1, va co che Coalescing Frame.

use serde::{Deserialize, Serialize};

/// Snapshot trang thai camera de gui ve React Shell
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CameraSnapshot {
    pub zoom: f32,
    pub pan_x: f32,
    pub pan_y: f32,
    pub dpr: f32,
    pub viewport_width: u32,
    pub viewport_height: u32,
}

/// UIUX (audit 2026-09-27 §V27.R8): version camera độc lập revision scene;
/// ACK fit/zoom muộn không được ghi đè input mới trong cùng trang.
#[derive(Debug,Clone,Copy,Serialize)]
pub struct CameraReply {
    #[serde(flatten)]
    pub camera: CameraSnapshot,
    #[serde(rename="cameraVersion")]
    pub camera_version: u64,
}

/// Bo dieu khien Viewport Native
pub struct ViewportController {
    /// Ty le phong to (1.0 = 100%, gioi han 0.05 ..= 64.0)
    pub zoom: f32,
    /// Do lech ngang theo DIP (Device-Independent Pixels)
    pub pan_x: f32,
    /// Do lech doc theo DIP
    pub pan_y: f32,
    /// Ty le pixel thiet bi (DPI scale: 1.0, 1.25, 1.5, 2.0)
    pub dpr: f32,
    /// Chieu rong viewport vat ly tren surface (physical pixels)
    pub physical_width: u32,
    /// Chieu cao viewport vat ly tren surface (physical pixels)
    pub physical_height: u32,
    /// Co dang trong thao tac keo chuot (dragging/panning)
    pub is_dragging: bool,
    /// Vi tri chuot bat dau keo (toa do DIP)
    pub drag_start: (f32, f32),
    /// So frame da render
    pub frame_counter: u64,
}

impl Default for ViewportController {
    fn default() -> Self {
        Self::new(800, 600, 1.0)
    }
}

impl ViewportController {
    pub fn new(physical_width: u32, physical_height: u32, dpr: f32) -> Self {
        Self {
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            dpr: if dpr > 0.0 { dpr } else { 1.0 },
            physical_width: physical_width.max(1),
            physical_height: physical_height.max(1),
            is_dragging: false,
            drag_start: (0.0, 0.0),
            frame_counter: 0,
        }
    }

    /// Tinh toan Anchor Zoom: thay doi zoom nhung giu nguyen diem neo tai con tro chuot (cursor_x, cursor_y)
    /// theo bat bien Schema v1 §2.2:
    /// X_scene = (cursor_x - Tx) / S
    /// T'x = cursor_x - S' * X_scene
    pub fn anchor_zoom(&mut self, cursor_x: f32, cursor_y: f32, factor: f32) {
        let old_zoom = self.zoom;
        let new_zoom = (old_zoom * factor).clamp(0.05, 64.0);

        if (new_zoom - old_zoom).abs() < 1e-5 {
            return;
        }

        // Tinh toa do diem neo trong he quy chieu Scene
        let scene_x = (cursor_x - self.pan_x) / old_zoom;
        let scene_y = (cursor_y - self.pan_y) / old_zoom;

        // Tinh do lech Pan moi de diem neo giu nguyen tai (cursor_x, cursor_y)
        self.pan_x = cursor_x - new_zoom * scene_x;
        self.pan_y = cursor_y - new_zoom * scene_y;
        self.zoom = new_zoom;
        self.frame_counter += 1;
    }

    /// Pan (dich chuyen khung nhin) theo delta (dx, dy)
    pub fn pan(&mut self, dx: f32, dy: f32) {
        self.pan_x += dx;
        self.pan_y += dy;
        self.frame_counter += 1;
    }

    /// UIUX (audit 2026-09-27 §V27.R8 / fix freeze zoom 2026-09-27):
    /// - Khi trang nhỏ hơn viewport (page <= viewport): cho phép pan tự do trong khung,
    ///   giữ ít nhất 16px của trang còn thấy ở mép viewport.
    /// - Khi trang lớn hơn viewport (page > viewport, zoom lớn): viewport phải di chuyển
    ///   TRONG trang, giữ mép ngoài trang không thụt sâu vào trong quá margin (64px),
    ///   tránh camera trôi ra ngoài khoảng xám mênh mông và kẹt pan khi zoom.
    /// Kích thước trang đã bao gồm UserUnit và Rotate.
    pub fn clamp_to_page(&mut self, page_width: f32, page_height: f32) {
        if !page_width.is_finite() || !page_height.is_finite()
            || page_width <= 0.0 || page_height <= 0.0 || !self.zoom.is_finite() || self.zoom <= 0.0 {
            return;
        }
        // UIUX (fix clamp & pan freeze 2026-09-27):
        // Giữ ít nhất 16px của trang còn thấy trong viewport ở mọi mức zoom.
        // Cho phép người dùng pan tự do đưa bất kỳ góc hay mép nào của trang vào giữa màn hình,
        // không bẫy camera trong khung 64px làm kẹt pan và hỏng điểm neo anchor zoom.
        fn limits(viewport: f32, page: f32) -> (f32, f32) {
            let visible = 16.0_f32.min(page).min(viewport);
            (visible - page, viewport - visible)
        }
        let vw = self.physical_width as f32 / self.dpr;
        let vh = self.physical_height as f32 / self.dpr;
        let (min_x, max_x) = limits(vw, page_width * self.zoom);
        let (min_y, max_y) = limits(vh, page_height * self.zoom);
        let next_x = self.pan_x.clamp(min_x, max_x);
        let next_y = self.pan_y.clamp(min_y, max_y);
        if next_x != self.pan_x || next_y != self.pan_y {
            self.pan_x = next_x;
            self.pan_y = next_y;
            self.frame_counter += 1;
        }
    }

    /// UIUX (audit 2026-09-25 §R25.GPU.32): wheel chỉ cuộn trong biên trang.
    /// Biên trả về là TRƯỚC delta: tới đáy rồi mới cho cử chỉ tiếp theo lật trang.
    /// Kéo bàn tay vẫn dùng pan() tự do; đơn vị kích thước trang đã gồm Rotate/UserUnit.
    pub fn scroll_page(&mut self, dx: f32, dy: f32, page_w: f32, page_h: f32) -> (bool, bool) {
        fn limits(viewport: f32, page: f32) -> (f32, f32) {
            if page <= viewport {
                let center = (viewport - page) / 2.;
                (center, center)
            } else {
                (viewport - page - 16., 16.)
            }
        }
        let (left,right)=limits(self.physical_width as f32/self.dpr,page_w*self.zoom);
        let (bottom,top)=limits(self.physical_height as f32/self.dpr,page_h*self.zoom);
        let edges=(self.pan_y >= top-0.01, self.pan_y <= bottom+0.01);
        let before=(self.pan_x,self.pan_y);
        if dx != 0. { self.pan_x=(self.pan_x+dx).clamp(left,right); }
        if dy != 0. { self.pan_y=(self.pan_y+dy).clamp(bottom,top); }
        if before != (self.pan_x,self.pan_y) { self.frame_counter+=1; }
        // Trang vừa khung luôn ở cả hai biên, kể cả sau zoom/pan trước đó.
        if top==bottom { (true,true) } else { edges }
    }

    /// Cap nhat kich thuoc physical surface va DPR khi resize
    pub fn update_surface_size(&mut self, width: u32, height: u32, dpr: Option<f32>) {
        self.physical_width = width.max(1);
        self.physical_height = height.max(1);
        if let Some(d) = dpr {
            if d > 0.0 {
                self.dpr = d;
            }
        }
        self.frame_counter += 1;
    }

    /// R34.05: Fit Page là một phép camera đầy đủ, không phải zoom quanh neo cũ.
    pub fn fit_page(&mut self, page_width: f32, page_height: f32, padding: f32) {
        self.fit_page_with_limit(page_width,page_height,padding,None);
    }
    pub fn fit_page_with_limit(&mut self,page_width:f32,page_height:f32,padding:f32,max_zoom:Option<f32>){
        if !page_width.is_finite() || !page_height.is_finite() || page_width <= 0.0 || page_height <= 0.0 { return; }
        let vw = self.physical_width as f32 / self.dpr;
        let vh = self.physical_height as f32 / self.dpr;
        let usable_w = (vw - padding * 2.0).max(1.0);
        let usable_h = (vh - padding * 2.0).max(1.0);
        self.zoom = (usable_w / page_width).min(usable_h / page_height).clamp(0.05, 64.0);
        if let Some(limit)=max_zoom.filter(|v|v.is_finite() && *v>0.){self.zoom=self.zoom.min(limit.clamp(0.05,64.));}
        self.pan_x = (vw - page_width * self.zoom) / 2.0;
        self.pan_y = (vh - page_height * self.zoom) / 2.0;
        self.is_dragging = false;
        self.frame_counter += 1;
    }

    /// Lay snapshot camera hien tai
    pub fn snapshot(&self) -> CameraSnapshot {
        CameraSnapshot {
            zoom: self.zoom,
            pan_x: self.pan_x,
            pan_y: self.pan_y,
            dpr: self.dpr,
            viewport_width: self.physical_width,
            viewport_height: self.physical_height,
        }
    }

    /// Chuyen doi diem tu Viewport Pixel (DIP) sang Scene Local (PDF Page Space)
    pub fn viewport_to_scene(&self, vp_x: f32, vp_y: f32) -> (f32, f32) {
        let scene_x = (vp_x - self.pan_x) / self.zoom;
        let scene_y = (vp_y - self.pan_y) / self.zoom;
        (scene_x, scene_y)
    }

    /// Chuyen doi diem tu Scene Local sang Viewport Pixel (DIP)
    pub fn scene_to_viewport(&self, scene_x: f32, scene_y: f32) -> (f32, f32) {
        let vp_x = scene_x * self.zoom + self.pan_x;
        let vp_y = scene_y * self.zoom + self.pan_y;
        (vp_x, vp_y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_centers_fit_page_and_respects_physical_dpr() {
        for dpr in [1.,1.5,2.] {
            let mut c=ViewportController::new((200.*dpr) as u32,(150.*dpr) as u32,dpr);
            c.pan_x=50.; c.pan_y=25.;
            assert_eq!(c.scroll_page(0.,-0.4,100.,100.),(true,true));
            assert_eq!((c.pan_x,c.pan_y),(50.,25.));
        }
    }
    #[test]
    fn wheel_scrolls_large_page_before_signalling_boundary() {
        let mut c=ViewportController::new(400,300,2.); c.pan_y=16.;
        assert_eq!(c.scroll_page(0.,-500.,400.,300.),(true,false));
        assert_eq!(c.pan_y,-166.);
        assert_eq!(c.scroll_page(0.,-1.,400.,300.),(false,true));
        assert_eq!(c.pan_y,-166.);
        c.scroll_page(0.,12.,400.,300.); assert_eq!(c.pan_y,-154.);
        c.scroll_page(-500.,0.,400.,300.); assert_eq!(c.pan_x,-216.);
    }
    #[test]
    fn wheel_keeps_fractional_distance_and_orthogonal_camera() {
        let mut c=ViewportController::new(400,300,2.); c.pan_x=-50.; c.pan_y=-50.;
        for _ in 0..4 { c.scroll_page(0.,-0.125,400.,300.); }
        assert_eq!((c.pan_x,c.pan_y),(-50.,-50.5));
    }
    #[test]
    fn camera_schema_matches_frontend_fixture() {
        // PERF (audit 2026-09-25 §R25.GPU.11): cùng artifact được hook test tiêu thụ.
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/viewer_gpu/native-camera-v1.json"
        )).unwrap();
        let actual = serde_json::to_value(ViewportController::new(1200, 900, 1.5).snapshot()).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn test_anchor_zoom_preserves_anchor_point() {
        let mut ctrl = ViewportController::new(1000, 800, 1.0);
        ctrl.pan_x = 100.0;
        ctrl.pan_y = 50.0;
        ctrl.zoom = 1.0;

        let cursor_x = 400.0;
        let cursor_y = 300.0;

        // Toa do scene truoc khi zoom
        let (s_x1, s_y1) = ctrl.viewport_to_scene(cursor_x, cursor_y);

        // Zoom 2x tai vi tri con tro
        ctrl.anchor_zoom(cursor_x, cursor_y, 2.0);
        assert_eq!(ctrl.zoom, 2.0);

        // Toa do scene sau khi zoom tai dung vi tri con tro (cursor_x, cursor_y)
        let (s_x2, s_y2) = ctrl.viewport_to_scene(cursor_x, cursor_y);

        assert!((s_x1 - s_x2).abs() < 1e-4, "Diem neo X phai duoc bao toan tuyet doi");
        assert!((s_y1 - s_y2).abs() < 1e-4, "Diem neo Y phai duoc bao toan tuyet doi");
    }
    #[test]
    fn anchor_remains_stable_after_visibility_clamp_near_page_edge(){
        let mut ctrl=ViewportController::new(1812,865,1.);
        ctrl.zoom=1.887;ctrl.pan_x=29.146;ctrl.pan_y=-100.;
        let before=ctrl.viewport_to_scene(1438.,400.);
        ctrl.anchor_zoom(1438.,400.,1.15);ctrl.clamp_to_page(748.35,561.26);
        let after=ctrl.viewport_to_scene(1438.,400.);
        assert!((after.0-before.0).abs()<0.0001 && (after.1-before.1).abs()<0.0001,
            "Clamp chỉ giữ trang còn nhìn thấy, không kéo mất điểm neo: {before:?} -> {after:?}");
    }

    #[test]
    fn test_pan_updates_coordinates() {
        let mut ctrl = ViewportController::new(800, 600, 1.0);
        ctrl.pan(50.0, -30.0);
        assert_eq!(ctrl.pan_x, 50.0);
        assert_eq!(ctrl.pan_y, -30.0);
    }

    #[test]
    fn clamp_to_page_keeps_page_visible_after_far_anchor_zoom() {
        let mut c = ViewportController::new(1596, 865, 1.0);
        c.zoom = 16.6;
        c.pan_x = -20_000.0;
        c.pan_y = -20_000.0;
        c.clamp_to_page(748.35, 561.26);
        assert!((c.pan_x+748.35*16.6).min(1596.)-c.pan_x.max(0.)>=15.99);
        assert!((c.pan_y+561.26*16.6).min(865.)-c.pan_y.max(0.)>=15.99);
    }

    #[test]
    fn fit_page_replaces_old_anchor_with_centered_camera() {
        let mut ctrl = ViewportController::new(800, 600, 1.0);
        ctrl.zoom = 2.0; ctrl.pan_x = -240.0; ctrl.pan_y = -360.0;
        ctrl.fit_page(400.0, 600.0, 32.0);
        assert!((ctrl.zoom - 0.8933333).abs() < 0.0001);
        assert!((ctrl.pan_x - 221.3333).abs() < 0.01);
        assert!((ctrl.pan_y - 32.0).abs() < 0.01);
    }

    #[test]
    fn clamp_to_page_allows_panning_and_anchor_when_page_fits_viewport() {
        let mut ctrl = ViewportController::new(1000, 800, 1.0);
        // Trang 400x500 nhỏ hơn viewport 1000x800 ở zoom 1.0
        ctrl.zoom = 1.0;
        // Giả sử người dùng kéo pan trang tới (150, 80)
        ctrl.pan_x = 150.0;
        ctrl.pan_y = 80.0;
        ctrl.clamp_to_page(400.0, 500.0);
        // Tọa độ pan không bị ép cứng về tâm ((1000-400)/2=300, (800-500)/2=150)
        assert_eq!(ctrl.pan_x, 150.0);
        assert_eq!(ctrl.pan_y, 80.0);

        // Kéo một phần trang ra ngoài vẫn hợp lệ, không cắt mất delta.
        ctrl.pan_x = -100.0;
        ctrl.clamp_to_page(400.0, 500.0);
        assert_eq!(ctrl.pan_x, -100.0);

        // Còn200px của trang trong viewport nên vẫn được giữ vị trí.
        ctrl.pan_x = 800.0;
        ctrl.clamp_to_page(400.0, 500.0);
        assert_eq!(ctrl.pan_x, 800.0);
        ctrl.pan_x=2000.;ctrl.clamp_to_page(400.,500.);assert_eq!(ctrl.pan_x,984.);
        ctrl.pan_x=-2000.;ctrl.clamp_to_page(400.,500.);assert_eq!(ctrl.pan_x,-384.);
    }
    #[test]
    fn smart_fit_cap_uses_calibrated_native_scale_and_keeps_center(){
        let mut c=ViewportController::new(1812,865,1.);let limit=0.958333333_f32*96./72.;
        c.fit_page_with_limit(748.35,561.26,32.,Some(limit));
        assert_eq!(c.zoom,limit);assert!((c.pan_x-(1812.-748.35*limit)/2.).abs()<0.001);
        assert!((c.pan_y-(865.-561.26*limit)/2.).abs()<0.001);
        c.fit_page(748.35,561.26,32.);assert!(c.zoom>limit,"Fit Page thường không bị cap Smart");
    }

    #[test]
    fn clamp_to_page_keeps_zoomed_page_on_screen_when_page_exceeds_viewport() {
        let mut ctrl = ViewportController::new(1812, 865, 1.0);
        ctrl.zoom = 5.17548;
        // page width = 748.346 * 5.17548 = 3873.05px
        // min_x = 16.0 - 3873.05 = -3857.05, max_x = 1812 - 16 = 1796.0
        ctrl.pan_x = -5000.0;
        ctrl.pan_y = -5000.0;
        ctrl.clamp_to_page(748.346, 561.26);
        let expected_min_x = 16.0 - 748.346 * 5.17548;
        let expected_min_y = 16.0 - 561.26 * 5.17548;
        assert!((ctrl.pan_x - expected_min_x).abs() < 1.0, "pan_x giữ ít nhất 16px của trang còn thấy: {}", ctrl.pan_x);
        assert!((ctrl.pan_y - expected_min_y).abs() < 1.0, "pan_y giữ ít nhất 16px của trang còn thấy: {}", ctrl.pan_y);

        // Kéo chuột pan trang sang phải (dx > 0)
        ctrl.pan(100.0, 50.0);
        ctrl.clamp_to_page(748.346, 561.26);
        assert!((ctrl.pan_x - (expected_min_x + 100.0)).abs() < 1.0);
        assert!((ctrl.pan_y - (expected_min_y + 50.0)).abs() < 1.0);
    }
}
