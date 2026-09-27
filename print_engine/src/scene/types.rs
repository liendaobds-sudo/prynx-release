//! PPE Viewer GPU - Scene IR Data Types
//!
//! Dac ta Scene IR bat bien theo Camera/Zoom (ISO 32000-2 & G1 Architecture).
//! Toan bo lenh ve, text, vector va anh cua trang PDF duoc bien dich thanh
//! cau truc SceneIR doc lap voi scale, offset va DPI man hinh.

use crate::geom::{Matrix, Rect};

/// Cac hop kich thuoc trang trong Scene IR.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScenePageBoxes {
    pub media: Rect,
    pub crop: Rect,
    pub trim: Option<Rect>,
    pub bleed: Option<Rect>,
    pub art: Option<Rect>,
}

impl ScenePageBoxes {
    pub fn new(media: Rect, crop: Rect) -> Self {
        Self {
            media,
            crop,
            trim: None,
            bleed: None,
            art: None,
        }
    }

    /// Kich thuoc hieu dung cua trang (thuong la CropBox).
    pub fn effective_rect(&self) -> Rect {
        self.crop
    }
}

/// Khong gian mau trong Scene IR.
#[derive(Debug, Clone, PartialEq)]
pub enum SceneColorSpace {
    DeviceGray,
    DeviceRGB,
    DeviceCMYK,
    Separation {
        name: String,
        alternate: Box<SceneColorSpace>,
    },
    DeviceN {
        names: Vec<String>,
        alternate: Box<SceneColorSpace>,
    },
    ICCBased {
        profile_id: String,
        num_components: usize,
    },
    Pattern,
}

/// Gia tri mau trong Scene IR.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneColor {
    pub space: SceneColorSpace,
    pub components: Vec<f32>,
}

impl SceneColor {
    pub fn black() -> Self {
        Self {
            space: SceneColorSpace::DeviceCMYK,
            components: vec![0.0, 0.0, 0.0, 1.0],
        }
    }

    pub fn cmyk(c: f32, m: f32, y: f32, k: f32) -> Self {
        Self {
            space: SceneColorSpace::DeviceCMYK,
            components: vec![c, m, y, k],
        }
    }
}

/// Che do to / ve duong vien.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenePaintMode {
    FillNonZero,
    FillEvenOdd,
    Stroke,
    FillAndStroke,
    Clip,
}

/// Lenh ve duong vector (Path).
#[derive(Debug, Clone, PartialEq)]
pub struct ScenePath {
    pub id: u64,
    pub paint_mode: ScenePaintMode,
    pub color: SceneColor,
    pub alpha: f32,
    pub stroke_width: f32,
    pub line_cap: u8,
    pub line_join: u8,
    pub miter_limit: f32,
    pub overprint: bool,
    pub transform: Matrix,
    pub bounds: Rect,
    pub path_data: Option<crate::scene::path_builder::ScenePathData>,
}

/// Lenh ve doan chu (Text Run).
#[derive(Debug, Clone, PartialEq)]
pub struct SceneTextRun {
    pub id: u64,
    pub font_name: String,
    pub font_size: f32,
    pub text: String,
    pub char_spacing: f32,
    pub word_spacing: f32,
    pub color: SceneColor,
    pub alpha: f32,
    pub overprint: bool,
    pub text_matrix: Matrix,
    pub bounds: Rect,
}

/// Lenh ve hinh anh (Image hoac Form XObject).
#[derive(Debug, Clone, PartialEq)]
pub struct SceneImage {
    pub id: u64,
    pub resource_id: String,
    pub width: u32,
    pub height: u32,
    pub transform: Matrix,
    pub interpolate: bool,
    pub is_mask: bool,
    pub bounds: Rect,
    pub invocation_key: Option<crate::scene::form_scope::InvocationKey>,
}

/// Lenh ve Shading (Gradient / Mesh).
#[derive(Debug, Clone, PartialEq)]
pub struct SceneShading {
    pub id: u64,
    pub shading_type: u8,
    pub bounds: Rect,
    pub transform: Matrix,
}

/// Nhom hoa tron (Blend Group).
#[derive(Debug, Clone, PartialEq)]
pub struct SceneGroupPush {
    pub id: u64,
    pub isolated: bool,
    pub knockout: bool,
    pub blend_mode: String,
    pub alpha: f32,
    pub bounds: Rect,
}

/// Lop cat (Clip Path).
#[derive(Debug, Clone, PartialEq)]
pub struct SceneClipPush {
    /// Hình học clip trong cùng hệ tọa độ với các path của scene.
    pub path_data: crate::scene::path_builder::ScenePathData,
    pub id: u64,
    pub even_odd: bool,
    pub bounds: Rect,
}

/// Lenh ve tong quat trong Scene IR.
#[derive(Debug, Clone, PartialEq)]
pub enum SceneCommand {
    Path(ScenePath),
    Text(SceneTextRun),
    Image(SceneImage),
    Shading(SceneShading),
    PushGroup(SceneGroupPush),
    PopGroup,
    PushClip(SceneClipPush),
    PopClip,
}

impl SceneCommand {
    pub fn bounds(&self) -> Option<Rect> {
        match self {
            SceneCommand::Path(p) => Some(p.bounds),
            SceneCommand::Text(t) => Some(t.bounds),
            SceneCommand::Image(img) => Some(img.bounds),
            SceneCommand::Shading(s) => Some(s.bounds),
            SceneCommand::PushGroup(g) => Some(g.bounds),
            SceneCommand::PushClip(c) => Some(c.bounds),
            SceneCommand::PopGroup | SceneCommand::PopClip => None,
        }
    }
}

/// Scene IR hoan chinh cua mot trang PDF (BAT BIEN theo Camera/Zoom).
#[derive(Debug, Clone)]
pub struct SceneIR {
    pub page_number: usize,
    pub revision: u64,
    pub boxes: ScenePageBoxes,
    pub rotation: i32,
    pub user_unit: f32,
    pub commands: Vec<SceneCommand>,
    pub bounds: Rect,
}

impl SceneIR {
    pub fn command_count(&self) -> usize {
        self.commands.len()
    }

    /// Kiem tra conservative bounds co bao phu toan bo noi dung trang.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

/// Camera Native Viewport - dieu phoi bien doi toa do tu Scene sang Physical Pixels.
///
/// BẤT BIẾN CỐT LÕI: Thao tac Camera thay doi chi anh huong toi Camera struct va ViewTransform,
/// TUYET DOI KHONG lam thay doi hoac phai bien dich lai SceneIR.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneCamera {
    pub scale: f32,
    pub pan_x: f32,
    pub pan_y: f32,
    pub dpr: f32,
    pub rotation: i32,
}

impl Default for SceneCamera {
    fn default() -> Self {
        Self {
            scale: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            dpr: 1.0,
            rotation: 0,
        }
    }
}

impl SceneCamera {
    pub fn new(scale: f32, pan_x: f32, pan_y: f32, dpr: f32) -> Self {
        Self {
            scale: scale.max(0.01),
            pan_x,
            pan_y,
            dpr: dpr.max(0.25),
            rotation: 0,
        }
    }

    /// Chuyen toa do tu Scene Local Space sang Physical Screen Pixels.
    pub fn scene_to_physical(&self, scene_x: f32, scene_y: f32) -> (f32, f32) {
        let vp_x = scene_x * self.scale + self.pan_x;
        let vp_y = scene_y * self.scale + self.pan_y;
        (vp_x * self.dpr, vp_y * self.dpr)
    }

    /// Chuyen nguoc tu Viewport Point sang Scene Local Space (cho Hit-Testing & Anchor).
    pub fn viewport_to_scene(&self, vp_x: f32, vp_y: f32) -> (f32, f32) {
        let scene_x = (vp_x - self.pan_x) / self.scale;
        let scene_y = (vp_y - self.pan_y) / self.scale;
        (scene_x, scene_y)
    }

    /// Tinh toan Pan Offset moi khi zoom co diem neo tai (cursor_x, cursor_y).
    pub fn zoom_at_anchor(&mut self, new_scale: f32, cursor_x: f32, cursor_y: f32) {
        let (scene_x, scene_y) = self.viewport_to_scene(cursor_x, cursor_y);
        self.scale = new_scale.max(0.01);
        self.pan_x = cursor_x - scene_x * self.scale;
        self.pan_y = cursor_y - scene_y * self.scale;
    }
}
