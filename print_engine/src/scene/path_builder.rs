//! PPE Viewer GPU - Scene Path Builder
//!
//! Xay dung duong vector tu cac operator PDF: `m`, `l`, `c`, `v`, `y`, `h`, `re`.
//! Toa do duoc ap dung CTM ngay tai thoi diem xay dung de luu trong Scene local space.

use crate::geom::{Matrix, Rect};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScenePoint {
    pub x: f32,
    pub y: f32,
}

impl ScenePoint {
    pub fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

/// Doan hinh hoc trong duong vector.
#[derive(Debug, Clone, PartialEq)]
pub enum PathSegment {
    MoveTo(ScenePoint),
    LineTo(ScenePoint),
    CubicTo {
        cp1: ScenePoint,
        cp2: ScenePoint,
        to: ScenePoint,
    },
    Close,
}

/// Mot subpath bao gom diem bat dau va chuoi cac doan noi tiep.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneSubpath {
    pub segments: Vec<PathSegment>,
    pub closed: bool,
}

impl SceneSubpath {
    pub fn new() -> Self {
        Self {
            segments: Vec::new(),
            closed: false,
        }
    }
}

/// Tap hop toan bo cac subpath cua mot doi tuong Path.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenePathData {
    pub subpaths: Vec<SceneSubpath>,
    pub bounds: Rect,
}

impl ScenePathData {
    pub fn is_empty(&self) -> bool {
        self.subpaths.is_empty()
    }
}

#[derive(Clone)]
pub struct PathBuilder {
    subpaths: Vec<SceneSubpath>,
    current_subpath: Option<SceneSubpath>,
    current_point: Option<ScenePoint>,
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
    has_points: bool,
}

impl PathBuilder {
    pub fn new() -> Self {
        Self {
            subpaths: Vec::new(),
            current_subpath: None,
            current_point: None,
            min_x: f32::INFINITY,
            min_y: f32::INFINITY,
            max_x: f32::NEG_INFINITY,
            max_y: f32::NEG_INFINITY,
            has_points: false,
        }
    }

    fn update_bounds(&mut self, pt: ScenePoint) {
        self.min_x = self.min_x.min(pt.x);
        self.min_y = self.min_y.min(pt.y);
        self.max_x = self.max_x.max(pt.x);
        self.max_y = self.max_y.max(pt.y);
        self.has_points = true;
    }

    /// Operator `m` (moveto)
    pub fn move_to(&mut self, x: f32, y: f32, ctm: &Matrix) {
        if let Some(sp) = self.current_subpath.take() {
            if !sp.segments.is_empty() {
                self.subpaths.push(sp);
            }
        }
        let (tx, ty) = ctm.apply(x, y);
        let pt = ScenePoint::new(tx, ty);
        self.update_bounds(pt);
        self.current_point = Some(pt);

        let mut sp = SceneSubpath::new();
        sp.segments.push(PathSegment::MoveTo(pt));
        self.current_subpath = Some(sp);
    }

    /// Operator `l` (lineto)
    pub fn line_to(&mut self, x: f32, y: f32, ctm: &Matrix) {
        let (tx, ty) = ctm.apply(x, y);
        let pt = ScenePoint::new(tx, ty);
        self.update_bounds(pt);
        self.current_point = Some(pt);

        if self.current_subpath.is_none() {
            let mut sp = SceneSubpath::new();
            sp.segments.push(PathSegment::MoveTo(pt));
            self.current_subpath = Some(sp);
        } else if let Some(ref mut sp) = self.current_subpath {
            sp.segments.push(PathSegment::LineTo(pt));
        }
    }

    /// Operator `c` (curveto: 2 diem dieu khien cp1, cp2 va diem dich to)
    pub fn cubic_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x3: f32, y3: f32, ctm: &Matrix) {
        let (tx1, ty1) = ctm.apply(x1, y1);
        let (tx2, ty2) = ctm.apply(x2, y2);
        let (tx3, ty3) = ctm.apply(x3, y3);

        let cp1 = ScenePoint::new(tx1, ty1);
        let cp2 = ScenePoint::new(tx2, ty2);
        let to = ScenePoint::new(tx3, ty3);

        self.update_bounds(cp1);
        self.update_bounds(cp2);
        self.update_bounds(to);
        self.current_point = Some(to);

        if self.current_subpath.is_none() {
            let mut sp = SceneSubpath::new();
            sp.segments.push(PathSegment::MoveTo(cp1));
            sp.segments.push(PathSegment::CubicTo { cp1, cp2, to });
            self.current_subpath = Some(sp);
        } else if let Some(ref mut sp) = self.current_subpath {
            sp.segments.push(PathSegment::CubicTo { cp1, cp2, to });
        }
    }

    /// Operator `v` (curveto voi diem dieu khien 1 trung voi current_point)
    pub fn curve_v(&mut self, x2: f32, y2: f32, x3: f32, y3: f32, ctm: &Matrix) {
        let current = self.current_point.unwrap_or(ScenePoint::new(0.0, 0.0));
        // Điểm hiện tại đã qua CTM; chỉ biến đổi hai điểm mới.
        let (x2, y2) = ctm.apply(x2, y2);
        let (x3, y3) = ctm.apply(x3, y3);
        self.cubic_to(current.x, current.y, x2, y2, x3, y3, &Matrix::IDENTITY);
    }

    /// Operator `y` (curveto voi diem dieu khien 2 trung voi diem dich)
    pub fn curve_y(&mut self, x1: f32, y1: f32, x3: f32, y3: f32, ctm: &Matrix) {
        self.cubic_to(x1, y1, x3, y3, x3, y3, ctm);
    }

    /// Operator `h` (closepath)
    pub fn close(&mut self) {
        if let Some(ref mut sp) = self.current_subpath {
            sp.segments.push(PathSegment::Close);
            sp.closed = true;
            if let Some(PathSegment::MoveTo(start)) = sp.segments.first() {
                self.current_point = Some(*start);
            }
        }
    }

    /// Operator `re` (rectangle: x, y, width, height)
    pub fn rectangle(&mut self, x: f32, y: f32, w: f32, h: f32, ctm: &Matrix) {
        self.move_to(x, y, ctm);
        self.line_to(x + w, y, ctm);
        self.line_to(x + w, y + h, ctm);
        self.line_to(x, y + h, ctm);
        self.close();
    }

    /// Hoan tat xay dung Path va lay ScenePathData
    pub fn finish(mut self) -> ScenePathData {
        if let Some(sp) = self.current_subpath.take() {
            if !sp.segments.is_empty() {
                self.subpaths.push(sp);
            }
        }

        let bounds = if self.has_points {
            Rect::new(self.min_x, self.min_y, self.max_x, self.max_y)
        } else {
            Rect::new(0.0, 0.0, 0.0, 0.0)
        };

        ScenePathData {
            subpaths: self.subpaths,
            bounds,
        }
    }
}
