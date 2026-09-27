//! PPE Viewer GPU - Scene Compiler
//!
//! Bien dich chuong trinh trang (PageProgram) thanh SceneIR bat bien.
//! Ho tro bóc tách duong cong Bézier (m, l, c, v, y, h, re), CTM stack (q, Q, cm),
//! va pham vi goi Form XObject (FormInvocationScopeManager).

use lopdf::Object;

use crate::error::{PpeError, PpeResult};
use crate::geom::{Matrix, Rect};
use crate::page_program::PageProgram;
use crate::scene::path_builder::PathBuilder;
use crate::scene::types::{
    SceneClipPush, SceneColor, SceneCommand, SceneIR, ScenePageBoxes, ScenePaintMode, ScenePath,
    SceneTextRun,
};

#[derive(Debug, Clone)]
struct CompilerGState {
    ctm: Matrix,
    fill_color: SceneColor,
    stroke_color: SceneColor,
    stroke_width: f32,
    line_cap: u8,
    line_join: u8,
    miter_limit: f32,
    alpha: f32,
    overprint: bool,
    clip_depth: usize,
    font_name: String,
    font_size: f32,
    char_spacing: f32,
    word_spacing: f32,
    leading: f32,
}

impl Default for CompilerGState {
    fn default() -> Self {
        Self {
            ctm: Matrix::IDENTITY,
            fill_color: SceneColor::black(),
            stroke_color: SceneColor::black(),
            stroke_width: 1.0,
            line_cap: 0,
            line_join: 0,
            miter_limit: 10.0,
            alpha: 1.0,
            overprint: false,
            clip_depth: 0,
            font_name: String::new(),
            font_size: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            leading: 0.0,
        }
    }
}

pub struct SceneCompiler {
    page_number: usize,
    revision: u64,
    boxes: ScenePageBoxes,
    rotation: i32,
    user_unit: f32,
}

impl SceneCompiler {
    pub fn new(page_number: usize, boxes: ScenePageBoxes, rotation: i32, user_unit: f32) -> Self {
        Self {
            page_number,
            revision: 1,
            boxes,
            rotation: normalize_rotation(rotation),
            user_unit: if user_unit > 0.0 { user_unit } else { 1.0 },
        }
    }

    pub fn with_revision(mut self, revision: u64) -> Self {
        self.revision = revision;
        self
    }

    /// Bien dich trang active tu PageProgram thanh SceneIR.
    pub fn compile_from_program(&self, program: &PageProgram) -> PpeResult<SceneIR> {
        let mut commands = Vec::new();
        let mut command_id = 0u64;

        let effective = self.boxes.effective_rect();
        let page_width = effective.width() * self.user_unit;
        let page_height = effective.height() * self.user_unit;

        // Tinh toan normalized bounds cho Scene local space
        let scene_bounds = match self.rotation {
            90 | 270 => Rect::new(0.0, 0.0, page_height, page_width),
            _ => Rect::new(0.0, 0.0, page_width, page_height),
        };

        // Ngan xep CTM va graphics state
        let mut gstate_stack = vec![CompilerGState::default()];
        let mut path_builder = PathBuilder::new();
        let mut pending_clip = None;
        let mut text_matrix = Matrix::IDENTITY;
        let mut text_line_matrix = Matrix::IDENTITY;

        for op in program.operations() {
            let op_name = op.operator.as_str();
            let current_gs = gstate_stack.last().cloned().unwrap_or_default();
            let current_ctm = current_gs.ctm;

            // PERF (audit 2026-09-25 §R25.GPU.02–03): W chỉ áp dụng SAU paint/end-path.
            let ending_path = matches!(
                op_name,
                "f" | "F" | "f*" | "S" | "s" | "B" | "B*" | "b" | "b*" | "n"
            );
            let clip_to_apply = if ending_path {
                pending_clip
                    .take()
                    .map(|even_odd| (even_odd, path_builder.clone().finish()))
            } else {
                None
            };
            match op_name {
                // --- Path Construction Operators ---
                "m" => {
                    if let (Some(x), Some(y)) = (get_f32(&op.operands, 0), get_f32(&op.operands, 1))
                    {
                        path_builder.move_to(x, y, &current_ctm);
                    }
                }
                "l" => {
                    if let (Some(x), Some(y)) = (get_f32(&op.operands, 0), get_f32(&op.operands, 1))
                    {
                        path_builder.line_to(x, y, &current_ctm);
                    }
                }
                "c" => {
                    if let (Some(x1), Some(y1), Some(x2), Some(y2), Some(x3), Some(y3)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                        get_f32(&op.operands, 3),
                        get_f32(&op.operands, 4),
                        get_f32(&op.operands, 5),
                    ) {
                        path_builder.cubic_to(x1, y1, x2, y2, x3, y3, &current_ctm);
                    }
                }
                "v" => {
                    if let (Some(x2), Some(y2), Some(x3), Some(y3)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                        get_f32(&op.operands, 3),
                    ) {
                        path_builder.curve_v(x2, y2, x3, y3, &current_ctm);
                    }
                }
                "y" => {
                    if let (Some(x1), Some(y1), Some(x3), Some(y3)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                        get_f32(&op.operands, 3),
                    ) {
                        path_builder.curve_y(x1, y1, x3, y3, &current_ctm);
                    }
                }
                "h" => {
                    path_builder.close();
                }
                "re" => {
                    if let (Some(x), Some(y), Some(w), Some(h)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                        get_f32(&op.operands, 3),
                    ) {
                        path_builder.rectangle(x, y, w, h, &current_ctm);
                    }
                }

                // --- Path Painting Operators ---
                "f" | "F" | "f*" => {
                    command_id = command_id.wrapping_add(1);
                    let paint_mode = match op_name {
                        "f*" => ScenePaintMode::FillEvenOdd,
                        _ => ScenePaintMode::FillNonZero,
                    };

                    let path_data =
                        std::mem::replace(&mut path_builder, PathBuilder::new()).finish();
                    let bounds = if path_data.is_empty() {
                        scene_bounds
                    } else {
                        path_data.bounds
                    };

                    commands.push(SceneCommand::Path(ScenePath {
                        id: command_id,
                        paint_mode,
                        color: current_gs.fill_color.clone(),
                        alpha: current_gs.alpha,
                        stroke_width: current_gs.stroke_width,
                        line_cap: current_gs.line_cap,
                        line_join: current_gs.line_join,
                        miter_limit: current_gs.miter_limit,
                        overprint: current_gs.overprint,
                        transform: current_ctm,
                        bounds,
                        path_data: Some(path_data),
                    }));
                }
                "S" | "s" => {
                    if op_name == "s" {
                        path_builder.close();
                    }
                    command_id = command_id.wrapping_add(1);
                    let path_data =
                        std::mem::replace(&mut path_builder, PathBuilder::new()).finish();
                    let bounds = if path_data.is_empty() {
                        scene_bounds
                    } else {
                        path_data.bounds
                    };

                    commands.push(SceneCommand::Path(ScenePath {
                        id: command_id,
                        paint_mode: ScenePaintMode::Stroke,
                        color: current_gs.stroke_color.clone(),
                        alpha: current_gs.alpha,
                        stroke_width: current_gs.stroke_width,
                        line_cap: current_gs.line_cap,
                        line_join: current_gs.line_join,
                        miter_limit: current_gs.miter_limit,
                        overprint: current_gs.overprint,
                        transform: current_ctm,
                        bounds,
                        path_data: Some(path_data),
                    }));
                }
                "B" | "b" | "B*" | "b*" => {
                    if op_name == "b" || op_name == "b*" {
                        path_builder.close();
                    }
                    let paint_mode = match op_name {
                        "B*" | "b*" => ScenePaintMode::FillEvenOdd,
                        _ => ScenePaintMode::FillNonZero,
                    };

                    let path_data =
                        std::mem::replace(&mut path_builder, PathBuilder::new()).finish();
                    let bounds = if path_data.is_empty() {
                        scene_bounds
                    } else {
                        path_data.bounds
                    };

                    // Fill command
                    command_id = command_id.wrapping_add(1);
                    commands.push(SceneCommand::Path(ScenePath {
                        id: command_id,
                        paint_mode,
                        color: current_gs.fill_color.clone(),
                        alpha: current_gs.alpha,
                        stroke_width: current_gs.stroke_width,
                        line_cap: current_gs.line_cap,
                        line_join: current_gs.line_join,
                        miter_limit: current_gs.miter_limit,
                        overprint: current_gs.overprint,
                        transform: current_ctm,
                        bounds,
                        path_data: Some(path_data.clone()),
                    }));

                    // Stroke command
                    command_id = command_id.wrapping_add(1);
                    commands.push(SceneCommand::Path(ScenePath {
                        id: command_id,
                        paint_mode: ScenePaintMode::Stroke,
                        color: current_gs.stroke_color.clone(),
                        alpha: current_gs.alpha,
                        stroke_width: current_gs.stroke_width,
                        line_cap: current_gs.line_cap,
                        line_join: current_gs.line_join,
                        miter_limit: current_gs.miter_limit,
                        overprint: current_gs.overprint,
                        transform: current_ctm,
                        bounds,
                        path_data: Some(path_data),
                    }));
                }
                "n" => {
                    let _ = std::mem::replace(&mut path_builder, PathBuilder::new()).finish();
                }

                // --- Color Operators ---
                "k" => {
                    if let (Some(c), Some(m), Some(y), Some(k)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                        get_f32(&op.operands, 3),
                    ) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.fill_color = SceneColor::cmyk(c, m, y, k);
                        }
                    }
                }
                "K" => {
                    if let (Some(c), Some(m), Some(y), Some(k)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                        get_f32(&op.operands, 3),
                    ) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.stroke_color = SceneColor::cmyk(c, m, y, k);
                        }
                    }
                }
                "rg" => {
                    if let (Some(r), Some(g), Some(b)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                    ) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.fill_color = SceneColor {
                                space: crate::scene::types::SceneColorSpace::DeviceRGB,
                                components: vec![r, g, b],
                            };
                        }
                    }
                }
                "RG" => {
                    if let (Some(r), Some(g), Some(b)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                    ) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.stroke_color = SceneColor {
                                space: crate::scene::types::SceneColorSpace::DeviceRGB,
                                components: vec![r, g, b],
                            };
                        }
                    }
                }
                "g" => {
                    if let Some(gray) = get_f32(&op.operands, 0) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.fill_color = SceneColor {
                                space: crate::scene::types::SceneColorSpace::DeviceGray,
                                components: vec![gray],
                            };
                        }
                    }
                }
                "G" => {
                    if let Some(gray) = get_f32(&op.operands, 0) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.stroke_color = SceneColor {
                                space: crate::scene::types::SceneColorSpace::DeviceGray,
                                components: vec![gray],
                            };
                        }
                    }
                }

                // --- Clipping Operators ---
                "W" | "W*" => {
                    pending_clip = Some(op_name == "W*");
                }
                "q" => {
                    gstate_stack.push(current_gs.clone());
                }
                "Q" => {
                    if gstate_stack.len() > 1 {
                        let old = gstate_stack.pop().unwrap();
                        let restored = gstate_stack.last().unwrap().clip_depth;
                        for _ in restored..old.clip_depth {
                            commands.push(SceneCommand::PopClip);
                        }
                    }
                }
                "cm" => {
                    if let (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f)) = (
                        get_f32(&op.operands, 0),
                        get_f32(&op.operands, 1),
                        get_f32(&op.operands, 2),
                        get_f32(&op.operands, 3),
                        get_f32(&op.operands, 4),
                        get_f32(&op.operands, 5),
                    ) {
                        let cm_op = Matrix::new(a, b, c, d, e, f);
                        if let Some(top) = gstate_stack.last_mut() {
                            top.ctm = cm_op.then(&top.ctm);
                        }
                    }
                }
                "w" => {
                    if let Some(width) = get_f32(&op.operands, 0) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.stroke_width = width.max(0.0);
                        }
                    }
                }
                "J" => {
                    if let Some(cap) = get_f32(&op.operands, 0) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.line_cap = cap as u8;
                        }
                    }
                }
                "j" => {
                    if let Some(join) = get_f32(&op.operands, 0) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.line_join = join as u8;
                        }
                    }
                }
                "M" => {
                    if let Some(miter) = get_f32(&op.operands, 0) {
                        if let Some(top) = gstate_stack.last_mut() {
                            top.miter_limit = miter.max(1.0);
                        }
                    }
                }

                // Dữ liệu text được giữ để phân giải font tại tầng có resources.
                "BT" => {
                    text_matrix = Matrix::IDENTITY;
                    text_line_matrix = Matrix::IDENTITY;
                }
                "ET" => {}
                "Tf" => {
                    let top = gstate_stack.last_mut().unwrap();
                    top.font_name = get_name(&op.operands, 0)
                        .ok_or_else(|| PpeError::ContentStream("Tf thiếu tên font".into()))?;
                    top.font_size = get_f32(&op.operands, 1)
                        .ok_or_else(|| PpeError::ContentStream("Tf thiếu cỡ font".into()))?;
                }
                "Tc" | "Tw" | "TL" => {
                    let value = get_f32(&op.operands, 0).ok_or_else(|| {
                        PpeError::ContentStream(format!("{op_name} thiếu toán hạng"))
                    })?;
                    let top = gstate_stack.last_mut().unwrap();
                    match op_name {
                        "Tc" => top.char_spacing = value,
                        "Tw" => top.word_spacing = value,
                        _ => top.leading = value,
                    }
                }
                "Tm" => {
                    let v: Option<Vec<_>> = (0..6).map(|i| get_f32(&op.operands, i)).collect();
                    let v = v.ok_or_else(|| PpeError::ContentStream("Tm thiếu ma trận".into()))?;
                    text_matrix = Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5]);
                    text_line_matrix = text_matrix;
                }
                "Td" | "TD" | "T*" => {
                    let (x, y) = if op_name == "T*" {
                        (0.0, -current_gs.leading)
                    } else {
                        (
                            get_f32(&op.operands, 0).unwrap_or(0.0),
                            get_f32(&op.operands, 1).unwrap_or(0.0),
                        )
                    };
                    if op_name == "TD" {
                        gstate_stack.last_mut().unwrap().leading = -y;
                    }
                    text_line_matrix = Matrix::translate(x, y).then(&text_line_matrix);
                    text_matrix = text_line_matrix;
                }
                "Tj" => {
                    let bytes = op
                        .operands
                        .first()
                        .and_then(|o| o.as_str().ok())
                        .ok_or_else(|| PpeError::ContentStream("Tj thiếu chuỗi chữ".into()))?;
                    // Chuỗi byte giữ nguyên theo mapping 1:1, chưa tự suy encoding/glyph của font.
                    let text: String = bytes.iter().map(|&b| char::from(b)).collect();
                    command_id += 1;
                    commands.push(SceneCommand::Text(SceneTextRun {
                        id: command_id,
                        font_name: current_gs.font_name.clone(),
                        font_size: current_gs.font_size,
                        text,
                        char_spacing: current_gs.char_spacing,
                        word_spacing: current_gs.word_spacing,
                        color: current_gs.fill_color.clone(),
                        alpha: current_gs.alpha,
                        overprint: current_gs.overprint,
                        text_matrix: text_matrix.then(&current_ctm),
                        bounds: scene_bounds,
                    }));
                }
                // Các operator cần tài nguyên/state chưa có trong compiler thuần phải fail rõ.
                // Không tạo Image 1x1, shading giả hoặc bỏ qua gs/OCG/TJ rồi trả scene thành công.
                _ => {
                    return Err(PpeError::Unsupported(format!(
                        "Scene trang {} cần phân giải operator {op_name} bằng PPE có resources",
                        self.page_number
                    )))
                }
            }
            if let Some((even_odd, path_data)) = clip_to_apply {
                command_id += 1;
                commands.push(SceneCommand::PushClip(SceneClipPush {
                    id: command_id,
                    even_odd,
                    bounds: path_data.bounds,
                    path_data,
                }));
                gstate_stack.last_mut().unwrap().clip_depth += 1;
            }
        }

        // PERF (audit 2026-09-25 §R25.GPU.03): culling phải bao cả bề dày nét/miter.
        for cmd in &mut commands {
            if let SceneCommand::Path(path) = cmd {
                if matches!(
                    path.paint_mode,
                    ScenePaintMode::Stroke | ScenePaintMode::FillAndStroke
                ) {
                    let m = path.transform;
                    let scale = (m.a.abs() + m.c.abs()).max(m.b.abs() + m.d.abs());
                    let extent = 0.5 * path.stroke_width * scale * path.miter_limit.max(1.0);
                    path.bounds = Rect::new(
                        path.bounds.x0 - extent,
                        path.bounds.y0 - extent,
                        path.bounds.x1 + extent,
                        path.bounds.y1 + extent,
                    );
                }
            }
        }
        // Tinh toan conservative bounds tong hop tu tat ca cac lenh ve
        let mut total_bounds = scene_bounds;
        for cmd in &commands {
            if let Some(b) = cmd.bounds() {
                total_bounds = Rect::new(
                    total_bounds.x0.min(b.x0),
                    total_bounds.y0.min(b.y0),
                    total_bounds.x1.max(b.x1),
                    total_bounds.y1.max(b.y1),
                );
            }
        }

        Ok(SceneIR {
            page_number: self.page_number,
            revision: self.revision,
            boxes: self.boxes,
            rotation: self.rotation,
            user_unit: self.user_unit,
            commands,
            bounds: total_bounds,
        })
    }
}

fn get_f32(operands: &[Object], idx: usize) -> Option<f32> {
    operands.get(idx).and_then(|obj| match obj {
        Object::Real(f) => Some(*f as f32),
        Object::Integer(i) => Some(*i as f32),
        _ => None,
    })
}

fn get_name(operands: &[Object], idx: usize) -> Option<String> {
    operands.get(idx).and_then(|obj| match obj {
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        _ => None,
    })
}

fn normalize_rotation(rotation: i32) -> i32 {
    let r = rotation % 360;
    let r = if r < 0 { r + 360 } else { r };
    match r {
        90 | 180 | 270 => r,
        _ => 0,
    }
}
