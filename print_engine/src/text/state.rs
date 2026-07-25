//! Trạng thái text (ISO 32000-2 §9.3).

use std::sync::Arc;

use crate::geom::Matrix;
use crate::text::font::LoadedFont;

/// Chế độ vẽ chữ — operator `Tr`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextRenderMode {
    Fill,
    Stroke,
    FillStroke,
    /// **Không vẽ gì.**
    Invisible,
    FillClip,
    StrokeClip,
    FillStrokeClip,
    /// Chỉ thêm vào clip, không vẽ.
    Clip,
}

impl TextRenderMode {
    pub fn from_code(code: i32) -> TextRenderMode {
        match code {
            1 => TextRenderMode::Stroke,
            2 => TextRenderMode::FillStroke,
            3 => TextRenderMode::Invisible,
            4 => TextRenderMode::FillClip,
            5 => TextRenderMode::StrokeClip,
            6 => TextRenderMode::FillStrokeClip,
            7 => TextRenderMode::Clip,
            _ => TextRenderMode::Fill,
        }
    }

    /// Chế độ này có đánh mực lên kẽm hay không.
    ///
    /// `Invisible` (3) và `Clip` (7) thì **không**. Đây là điều tuyệt đối không
    /// được làm sai: file scan có OCR đều mang một lớp chữ vô hình phủ toàn trang
    /// ở chế độ 3. Vẽ nó ra là đổ mực đen kín trang và mọi số đo mực thành rác.
    pub fn paints_ink(self) -> bool {
        !matches!(self, TextRenderMode::Invisible | TextRenderMode::Clip)
    }

    pub fn fills(self) -> bool {
        matches!(
            self,
            TextRenderMode::Fill
                | TextRenderMode::FillStroke
                | TextRenderMode::FillClip
                | TextRenderMode::FillStrokeClip
        )
    }

    pub fn strokes(self) -> bool {
        matches!(
            self,
            TextRenderMode::Stroke
                | TextRenderMode::FillStroke
                | TextRenderMode::StrokeClip
                | TextRenderMode::FillStrokeClip
        )
    }

    pub fn adds_to_clip(self) -> bool {
        matches!(
            self,
            TextRenderMode::FillClip
                | TextRenderMode::StrokeClip
                | TextRenderMode::FillStrokeClip
                | TextRenderMode::Clip
        )
    }
}

/// Tham số text nằm trong graphics state (tồn tại qua `BT`/`ET`).
#[derive(Clone)]
pub struct TextState {
    pub font: Option<Arc<LoadedFont>>,
    /// Tên resource của font, để báo lỗi.
    pub font_name: String,
    pub size: f32,
    /// `Tc` — giãn ký tự, đơn vị không gian text.
    pub char_spacing: f32,
    /// `Tw` — giãn từ. Chỉ áp cho **mã byte 32 đơn byte** (§9.3.3).
    pub word_spacing: f32,
    /// `Tz` — tỉ lệ ngang, đã chia 100.
    pub horizontal_scale: f32,
    /// `TL` — khoảng dòng.
    pub leading: f32,
    /// `Ts` — nâng chữ.
    pub rise: f32,
    pub render_mode: TextRenderMode,
}

impl Default for TextState {
    fn default() -> Self {
        TextState {
            font: None,
            font_name: String::new(),
            size: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            horizontal_scale: 1.0,
            leading: 0.0,
            rise: 0.0,
            render_mode: TextRenderMode::Fill,
        }
    }
}

/// Ma trận text, chỉ tồn tại trong khối `BT`…`ET`.
#[derive(Debug, Clone, Copy)]
pub struct TextObject {
    /// `Tm` — ma trận text hiện hành.
    pub matrix: Matrix,
    /// Ma trận đầu dòng, `T*` và `Td` dựa vào nó.
    pub line_matrix: Matrix,
}

impl Default for TextObject {
    fn default() -> Self {
        TextObject {
            matrix: Matrix::IDENTITY,
            line_matrix: Matrix::IDENTITY,
        }
    }
}

impl TextObject {
    /// `Td` — xuống dòng mới với độ dịch cho trước.
    pub fn next_line_offset(&mut self, tx: f32, ty: f32) {
        self.line_matrix = Matrix::translate(tx, ty).then(&self.line_matrix);
        self.matrix = self.line_matrix;
    }

    /// `Tm` — đặt lại cả hai ma trận.
    pub fn set_matrix(&mut self, m: Matrix) {
        self.matrix = m;
        self.line_matrix = m;
    }

    /// Tiến con trỏ sau khi vẽ một glyph.
    pub fn advance(&mut self, tx: f32, ty: f32) {
        self.matrix = Matrix::translate(tx, ty).then(&self.matrix);
    }
}

/// Ma trận đưa glyph (không gian text, cỡ 1) về không gian người dùng.
///
/// `Trm = [Tfs·Th  0  0  Tfs  0  Ts] × Tm` (§9.4.4). Nhân thêm CTM ở nơi gọi.
pub fn glyph_matrix(state: &TextState, text_matrix: &Matrix) -> Matrix {
    Matrix::new(
        state.size * state.horizontal_scale,
        0.0,
        0.0,
        state.size,
        0.0,
        state.rise,
    )
    .then(text_matrix)
}

/// Độ tiến ngang sau một glyph, trong không gian text.
///
/// `tx = ((w0 − Tj/1000) · Tfs + Tc + Tw) · Th`
///
/// `word_spacing` chỉ được truyền `true` cho **mã byte 32 của font đơn byte**:
/// với font 2 byte, mã 32 không phải dấu cách và cộng `Tw` vào đó sẽ giãn chữ
/// CJK ra sai chỗ (§9.3.3).
pub fn glyph_advance(
    state: &TextState,
    glyph_width: f32,
    apply_word_spacing: bool,
) -> f32 {
    let mut tx = glyph_width * state.size + state.char_spacing;
    if apply_word_spacing {
        tx += state.word_spacing;
    }
    tx * state.horizontal_scale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_mode_codes_map_correctly() {
        assert_eq!(TextRenderMode::from_code(0), TextRenderMode::Fill);
        assert_eq!(TextRenderMode::from_code(3), TextRenderMode::Invisible);
        assert_eq!(TextRenderMode::from_code(7), TextRenderMode::Clip);
        assert_eq!(TextRenderMode::from_code(42), TextRenderMode::Fill, "mã lạ → Fill");
    }

    #[test]
    fn invisible_and_clip_modes_paint_no_ink() {
        // Lớp OCR của file scan dùng chế độ 3 và phủ kín trang.
        assert!(!TextRenderMode::Invisible.paints_ink());
        assert!(!TextRenderMode::Clip.paints_ink());
        assert!(TextRenderMode::Fill.paints_ink());
        assert!(TextRenderMode::Stroke.paints_ink());
    }

    #[test]
    fn fill_stroke_flags_match_mode() {
        assert!(TextRenderMode::FillStroke.fills());
        assert!(TextRenderMode::FillStroke.strokes());
        assert!(!TextRenderMode::Stroke.fills());
        assert!(TextRenderMode::FillClip.adds_to_clip());
        assert!(!TextRenderMode::Fill.adds_to_clip());
    }

    #[test]
    fn glyph_matrix_applies_size_and_rise() {
        let mut st = TextState::default();
        st.size = 12.0;
        st.rise = 3.0;
        let m = glyph_matrix(&st, &Matrix::IDENTITY);
        // Điểm (1,0) trong không gian glyph → (12, 3).
        assert_eq!(m.apply(1.0, 0.0), (12.0, 3.0));
    }

    #[test]
    fn glyph_matrix_applies_horizontal_scale_only_to_x() {
        let mut st = TextState::default();
        st.size = 10.0;
        st.horizontal_scale = 0.5;
        let m = glyph_matrix(&st, &Matrix::IDENTITY);
        assert_eq!(m.apply(1.0, 1.0), (5.0, 10.0));
    }

    #[test]
    fn advance_includes_char_spacing_and_scale() {
        let mut st = TextState::default();
        st.size = 10.0;
        st.char_spacing = 2.0;
        st.horizontal_scale = 2.0;
        // (0.5*10 + 2) * 2 = 14
        assert_eq!(glyph_advance(&st, 0.5, false), 14.0);
    }

    #[test]
    fn word_spacing_only_when_requested() {
        let mut st = TextState::default();
        st.size = 10.0;
        st.word_spacing = 5.0;
        assert_eq!(glyph_advance(&st, 0.5, false), 5.0);
        assert_eq!(glyph_advance(&st, 0.5, true), 10.0);
    }

    #[test]
    fn td_resets_to_line_start_not_current_position() {
        // Sai chỗ này làm mỗi dòng dịch dồn theo dòng trước.
        let mut obj = TextObject::default();
        obj.advance(100.0, 0.0);
        obj.next_line_offset(0.0, -12.0);
        assert_eq!(obj.matrix.apply(0.0, 0.0), (0.0, -12.0));
    }

    #[test]
    fn successive_lines_accumulate_from_line_matrix() {
        let mut obj = TextObject::default();
        obj.next_line_offset(0.0, -12.0);
        obj.next_line_offset(0.0, -12.0);
        assert_eq!(obj.matrix.apply(0.0, 0.0), (0.0, -24.0));
    }

    #[test]
    fn set_matrix_resets_both_matrices() {
        let mut obj = TextObject::default();
        obj.advance(50.0, 0.0);
        obj.set_matrix(Matrix::translate(7.0, 8.0));
        obj.next_line_offset(0.0, 0.0);
        assert_eq!(obj.matrix.apply(0.0, 0.0), (7.0, 8.0));
    }
}
