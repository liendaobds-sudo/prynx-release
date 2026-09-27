//! PERF (audit 2026-09-25 §R25.GPU.02): display list từ chính interpreter PPE.
//!
//! Resource đã giải mã sống cùng scene. Tọa độ vẫn là PDF user space; camera
//! chỉ áp khi replay. Không giữ clip/soft-mask đã raster ở một DPI cố định.
use std::sync::Arc;
use tiny_skia::Path;
use crate::{content::BlendSpace, error::RenderWarnings, geom::{Matrix, Rect},
    image::sampler::SampledImage, ink::{InkPaint, InkSpace}, raster::FillRule,
    shading::Shading};

#[derive(Clone, Default)]
pub struct RetainedState {
    pub clip: Option<Arc<RetainedClip>>,
    pub mask: Option<Arc<RetainedMask>>,
    pub alpha_is_shape: bool,
    pub overprint_mode: i32,
}

/// Các path trong cùng nút hợp lại trước khi giao với clip cha (text clip).
pub struct RetainedClip {
    pub parent: Option<Arc<RetainedClip>>,
    pub paths: Vec<Path>,
    pub rule: FillRule,
    pub stroke: Option<RetainedClipStroke>,
}
pub struct RetainedClipStroke {pub path:Path,pub matrix:Matrix,pub style:RetainedStroke}

pub struct RetainedMask {
    pub commands: Vec<RetainedDraw>,
    pub luminosity: bool,
    pub backdrop: InkPaint,
    pub blend_space: BlendSpace,
    pub transfer: Option<Vec<f32>>,
}

pub enum RetainedKind {
    Path { path: Path, rule: FillRule },
    Stroke { path: Path, matrix: Matrix, style: RetainedStroke },
    Image { image: Arc<SampledImage>, matrix: Matrix, interpolate: bool },
    Shading { shading: Arc<Shading>, matrix: Matrix },
    Group { commands: Vec<RetainedDraw>, isolated: bool, knockout: bool,
        blend_space: BlendSpace },
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct RetainedStroke {pub width:f32,pub cap:u8,pub join:u8,pub miter:f32,pub dash:Vec<f32>,pub phase:f32}
impl RetainedStroke {
    pub fn from_state(s:&crate::content::gstate::GraphicsState)->Self {
        Self{width:s.line_width,cap:match s.line_cap {tiny_skia::LineCap::Butt=>0,tiny_skia::LineCap::Round=>1,tiny_skia::LineCap::Square=>2},
            join:match s.line_join {tiny_skia::LineJoin::Miter=>0,tiny_skia::LineJoin::Round=>1,tiny_skia::LineJoin::Bevel=>2,tiny_skia::LineJoin::MiterClip=>3},
            miter:s.miter_limit,dash:s.dash_array.clone(),phase:s.dash_phase}
    }
    pub fn is_valid(&self)->bool{self.width.is_finite() && self.width>=0. && self.miter.is_finite() && self.phase.is_finite() && self.cap<=2 && self.join<=3 && self.dash.iter().all(|v|v.is_finite())}
    /// Hairline và độ phân giải đường cong đi theo camera; không đóng băng ở DPI compile.
    pub fn device_path(&self,path:&Path,matrix:Matrix)->Option<Path>{
        let transform=tiny_skia::Transform::from_row(matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f);
        let resolution=tiny_skia::PathStroker::compute_resolution_scale(&transform);
        let dash=crate::content::gstate::normalize_dash_array(&self.dash).and_then(|v|tiny_skia::StrokeDash::new(v,self.phase.max(0.)));
        let dashed=if let Some(d)=&dash {path.dash(d,resolution)?}else{path.clone()};
        let stroke=tiny_skia::Stroke{width:crate::raster::mask::effective_line_width(self.width,&matrix),miter_limit:self.miter.max(1.),
            line_cap:match self.cap{1=>tiny_skia::LineCap::Round,2=>tiny_skia::LineCap::Square,_=>tiny_skia::LineCap::Butt},
            line_join:match self.join{1=>tiny_skia::LineJoin::Round,2=>tiny_skia::LineJoin::Bevel,3=>tiny_skia::LineJoin::MiterClip,_=>tiny_skia::LineJoin::Miter},dash:None};
        dashed.stroke(&stroke,resolution)?.transform(transform)
    }
}

pub struct RetainedDraw {
    pub kind: RetainedKind,
    pub paint: InkPaint,
    pub state: RetainedState,
    pub blend_space: BlendSpace,
}

pub struct RetainedPage {
    pub commands: Vec<RetainedDraw>,
    pub space: InkSpace,
    pub bounds: Rect,
    pub rotation: i32,
    pub user_unit: f32,
    pub warnings: RenderWarnings,
}

#[derive(Default)]
pub(crate) struct Recorder {
    pub commands: Vec<RetainedDraw>,
    pub text_clip: Vec<Path>,
    pub stream_base: Option<crate::content::gstate::GraphicsState>,
}

impl RetainedState {
    pub fn intersect(&mut self, paths: Vec<Path>, rule: FillRule) {
        self.clip = Some(Arc::new(RetainedClip { parent: self.clip.clone(), paths, rule, stroke:None }));
    }
}

impl RetainedPage {
    /// Font, image, Form, SMask, OCG, colorspace đều dùng resolver PPE hiện có.
    pub fn compile(doc: &lopdf::Document, page: usize, opts: crate::content::RenderOptions,
        color: Option<&crate::color::icc::ColorManager>) -> crate::error::PpeResult<Self> {
        crate::content::Renderer::compile_retained_page(doc, page, opts, color)
    }

    /// Camera dùng gốc trên trái sau CropBox, Rotate và UserUnit.
    pub fn page_to_view(&self, scale: f32, x: f32, y: f32) -> Matrix {
        let b = self.bounds;
        let s = scale * self.user_unit;
        let base = match self.rotation.rem_euclid(360) {
            90 => Matrix::new(0.0, s, s, 0.0, -b.y0*s, -b.x0*s),
            180 => Matrix::new(-s, 0.0, 0.0, s, b.x1*s, -b.y0*s),
            270 => Matrix::new(0.0, -s, -s, 0.0, b.y1*s, b.x1*s),
            _ => Matrix::new(s, 0.0, 0.0, -s, -b.x0*s, b.y1*s),
        };
        base.then(&Matrix::translate(x, y))
    }
}
