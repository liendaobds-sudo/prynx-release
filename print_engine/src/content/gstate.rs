//! Trạng thái đồ hoạ (graphics state) và ngăn xếp `q`/`Q`.

use std::sync::Arc;

use tiny_skia::{LineCap, LineJoin, Mask, Stroke, StrokeDash};

use crate::blend::BlendMode;
use crate::color::ColorSpace;
use crate::geom::Matrix;
use crate::raster::mask::effective_line_width;
use crate::text::state::TextState;

/// Trạng thái đồ hoạ theo ISO 32000-2 §8.4, giới hạn ở phần ảnh hưởng tới mực.
///
/// Chưa mô hình hoá: halftone, transfer function, flatness, smoothness — chúng
/// ảnh hưởng tới **tram** ở RIP chứ không tới lượng mực danh nghĩa mà PrynX đo.
#[derive(Clone)]
pub struct GraphicsState {
    pub ctm: Matrix,

    pub fill_cs: ColorSpace,
    pub fill_comps: Vec<f32>,
    pub stroke_cs: ColorSpace,
    pub stroke_comps: Vec<f32>,

    pub line_width: f32,
    pub line_cap: LineCap,
    pub line_join: LineJoin,
    pub miter_limit: f32,
    pub dash_array: Vec<f32>,
    pub dash_phase: f32,

    /// `ca` — alpha hằng khi tô.
    pub fill_alpha: f32,
    /// `CA` — alpha hằng khi vẽ nét.
    pub stroke_alpha: f32,

    /// `op` — overprint khi tô.
    pub fill_overprint: bool,
    /// `OP` — overprint khi vẽ nét.
    pub stroke_overprint: bool,
    /// `OPM` — 0 hoặc 1.
    pub overprint_mode: i32,

    /// `BM` — blend mode.
    pub blend_mode: BlendMode,

    /// Soft mask hiện hành (`/SMask` trong ExtGState), đã raster ở **toạ độ thiết
    /// bị**, dài `width*height`, giá trị 0.0..=1.0.
    ///
    /// Nằm trong graphics state chứ không phải tham số của từng thao tác vẽ vì spec
    /// bắt nó nhân vào alpha của **mọi** thao tác cho tới khi `gs` khác thay đổi
    /// (§11.6.4.3). `Arc` vì `q` phải nhân bản trạng thái mà mặt nạ cỡ cả trang.
    ///
    /// Mặt nạ được dựng **một lần** tại `gs`, với CTM lúc đó — đúng spec: soft mask
    /// không đi theo `cm` sau này. Dựng lại theo CTM hiện hành sẽ làm mặt nạ trượt
    /// khỏi hình mà nó phải che.
    pub soft_mask: Option<Arc<Vec<f32>>>,

    /// Mặt nạ clip hiện hành. `None` = không clip (toàn trang).
    ///
    /// `Arc` để `q` chỉ tăng đếm tham chiếu; clip là mảng cỡ cả trang nên copy
    /// theo giá trị ở mỗi `q` sẽ rất đắt trong file có hàng nghìn `q/Q`.
    pub clip: Option<Arc<Mask>>,

    /// Tham số text. Nằm trong graphics state (không phải trong text object) nên
    /// sống qua `BT`/`ET` và được `q`/`Q` lưu/phục hồi — đúng §9.3.
    pub text: TextState,

    /// Tên pattern đang chọn cho tô / vẽ nét (`scn` / `SCN` với toán hạng tên).
    ///
    /// Lưu **tên** chứ không lưu pattern đã phân giải: chỉ tới lúc vẽ mới cần biết
    /// nó là shading pattern (vẽ được) hay tiling pattern (chưa dựng), và phân giải
    /// sớm sẽ làm mọi `scn` phải đọc resources dù có vẽ hay không.
    pub fill_pattern: Option<String>,
    pub stroke_pattern: Option<String>,
}

impl GraphicsState {
    /// Trạng thái khởi tạo theo spec: màu đen, nét 1.0, không overprint.
    pub fn initial(ctm: Matrix) -> Self {
        GraphicsState {
            ctm,
            fill_cs: ColorSpace::DeviceGray,
            fill_comps: vec![0.0],
            stroke_cs: ColorSpace::DeviceGray,
            stroke_comps: vec![0.0],
            line_width: 1.0,
            line_cap: LineCap::Butt,
            line_join: LineJoin::Miter,
            miter_limit: 10.0,
            dash_array: Vec::new(),
            dash_phase: 0.0,
            fill_alpha: 1.0,
            stroke_alpha: 1.0,
            fill_overprint: false,
            stroke_overprint: false,
            overprint_mode: 0,
            blend_mode: BlendMode::Normal,
            soft_mask: None,
            clip: None,
            text: TextState::default(),
            fill_pattern: None,
            stroke_pattern: None,
        }
    }

    /// Dựng tham số nét cho bộ rasterize, đã xử lý hairline và dash.
    pub fn build_stroke(&self) -> Stroke {
        let width = effective_line_width(self.line_width, &self.ctm);
        let dash = build_dash(&self.dash_array, self.dash_phase);
        Stroke {
            width,
            miter_limit: self.miter_limit.max(1.0),
            line_cap: self.line_cap,
            line_join: self.line_join,
            dash,
        }
    }
}

/// Chuyển `d` của PDF thành dash của bộ rasterize.
///
/// Mảng rỗng, toàn số 0, hoặc có số âm ⇒ nét liền (§8.4.3.6). Bỏ qua các quy tắc
/// này sẽ làm nét biến mất thay vì liền — mất đường bế trên kẽm.
fn build_dash(array: &[f32], phase: f32) -> Option<StrokeDash> {
    let arr = normalize_dash_array(array)?;
    StrokeDash::new(arr, phase.max(0.0))
}

/// Chuẩn hoá mảng dash; `None` = nét liền.
pub fn normalize_dash_array(array: &[f32]) -> Option<Vec<f32>> {
    if array.is_empty() || array.iter().any(|v| *v < 0.0) || array.iter().all(|v| *v == 0.0) {
        return None;
    }
    // Bộ rasterize cần số phần tử chẵn; PDF cho phép lẻ (nghĩa là lặp lại).
    let mut arr = array.to_vec();
    if arr.len() % 2 == 1 {
        arr.extend_from_slice(array);
    }
    Some(arr)
}

/// Ngăn xếp `q`/`Q`.
///
/// PDF hỏng có thể chứa `Q` không cân, hoặc `q` lồng vô hạn. Ngăn xếp này không
/// bao giờ để rỗng và có trần độ sâu — một `Q` thừa không được phép làm sập
/// engine hay xoá trạng thái gốc.
pub struct StateStack {
    stack: Vec<GraphicsState>,
    /// Số `Q` thừa đã gặp — báo lên cảnh báo để biết file lệch cấu trúc.
    pub unbalanced_restores: u32,
}

/// Trần độ sâu `q` — spec khuyến nghị 28, thực tế file sinh tự động sâu hơn.
const MAX_STATE_DEPTH: usize = 256;

impl StateStack {
    pub fn new(initial: GraphicsState) -> Self {
        StateStack {
            stack: vec![initial],
            unbalanced_restores: 0,
        }
    }

    pub fn current(&self) -> &GraphicsState {
        self.stack
            .last()
            .expect("ngăn xếp luôn có ít nhất 1 phần tử")
    }

    pub fn current_mut(&mut self) -> &mut GraphicsState {
        self.stack
            .last_mut()
            .expect("ngăn xếp luôn có ít nhất 1 phần tử")
    }

    pub fn depth(&self) -> usize {
        self.stack.len()
    }

    /// `q` — lưu trạng thái.
    pub fn save(&mut self) {
        if self.stack.len() >= MAX_STATE_DEPTH {
            return;
        }
        let top = self.current().clone();
        self.stack.push(top);
    }

    /// `Q` — phục hồi. Không bao giờ làm rỗng ngăn xếp.
    pub fn restore(&mut self) {
        if self.stack.len() > 1 {
            self.stack.pop();
        } else {
            self.unbalanced_restores += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> GraphicsState {
        GraphicsState::initial(Matrix::IDENTITY)
    }

    #[test]
    fn initial_state_matches_spec_defaults() {
        let g = state();
        assert_eq!(g.line_width, 1.0);
        assert_eq!(g.fill_alpha, 1.0);
        assert!(!g.fill_overprint);
        assert_eq!(g.overprint_mode, 0);
        assert_eq!(g.fill_comps, vec![0.0], "màu khởi tạo là đen");
    }

    #[test]
    fn save_restore_isolates_changes() {
        let mut s = StateStack::new(state());
        s.save();
        s.current_mut().line_width = 9.0;
        s.current_mut().fill_overprint = true;
        s.restore();
        assert_eq!(s.current().line_width, 1.0);
        assert!(!s.current().fill_overprint);
    }

    #[test]
    fn unbalanced_restore_does_not_empty_stack() {
        // PDF hỏng có `Q` thừa; engine phải sống sót và ghi nhận.
        let mut s = StateStack::new(state());
        s.restore();
        s.restore();
        assert_eq!(s.depth(), 1);
        assert_eq!(s.unbalanced_restores, 2);
    }

    #[test]
    fn state_depth_is_capped() {
        let mut s = StateStack::new(state());
        for _ in 0..(MAX_STATE_DEPTH + 50) {
            s.save();
        }
        assert!(s.depth() <= MAX_STATE_DEPTH);
    }

    #[test]
    fn empty_dash_array_means_solid_line() {
        assert!(build_dash(&[], 0.0).is_none());
    }

    #[test]
    fn all_zero_dash_array_means_solid_line() {
        // `[0 0] 0 d` là nét liền, KHÔNG phải nét vô hình.
        assert!(build_dash(&[0.0, 0.0], 0.0).is_none());
    }

    #[test]
    fn negative_dash_value_means_solid_line() {
        assert!(build_dash(&[3.0, -1.0], 0.0).is_none());
    }

    #[test]
    fn odd_dash_array_is_repeated_to_even_length() {
        let arr = normalize_dash_array(&[3.0]).expect("dash hợp lệ");
        assert_eq!(arr.len() % 2, 0);
        assert_eq!(arr, vec![3.0, 3.0]);
        assert!(build_dash(&[3.0], 0.0).is_some());
    }

    #[test]
    fn valid_dash_is_kept() {
        assert!(build_dash(&[4.0, 2.0], 1.0).is_some());
    }

    #[test]
    fn hairline_stroke_width_survives_build() {
        let mut g = state();
        g.line_width = 0.0;
        let s = g.build_stroke();
        assert!(s.width > 0.0, "nét 0 không được thành vô hình");
    }

    #[test]
    fn miter_limit_below_one_is_clamped() {
        let mut g = state();
        g.miter_limit = 0.0;
        assert!(g.build_stroke().miter_limit >= 1.0);
    }
}
