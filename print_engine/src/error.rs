//! Lỗi của PPE.
//!
//! Nguyên tắc P4 "fail loud" của plan: engine **không** được im lặng trả buffer
//! trắng khi không hiểu file. Mọi nhánh không xử lý được phải nổi lên thành lỗi
//! hoặc thành cảnh báo đếm được (`RenderWarnings`), để lớp trên không báo "sạch
//! TAC" trên một trang chưa hề được vẽ.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PpeError {
    #[error("không mở được PDF: {0}")]
    OpenFailed(String),

    #[error("không tìm thấy trang {requested} (tài liệu có {total} trang)")]
    PageOutOfRange { requested: usize, total: usize },

    #[error("cấu trúc PDF không hợp lệ: {0}")]
    MalformedPdf(String),

    #[error("content stream lỗi: {0}")]
    ContentStream(String),

    #[error("kích thước raster không hợp lệ: {w}x{h} @ {dpi} DPI")]
    BadRasterSize { w: i64, h: i64, dpi: f32 },

    #[error("vượt trần {limit} mực (colorant); trang dùng nhiều spot hơn engine hỗ trợ")]
    TooManyColorants { limit: usize },

    #[error("PDF có mã hoá chưa hỗ trợ: {0}")]
    Unsupported(String),
}

pub type PpeResult<T> = Result<T, PpeError>;

/// Cảnh báo tích luỹ trong một lần render.
///
/// Đây là hạ tầng cho capability matrix (`engine` / `accuracy` / `quality_note`)
/// mà API prepress đang trả về: nếu trang có thứ engine chưa vẽ đúng, lớp Python
/// phải hạ `accuracy` chứ không được coi kết quả là chuẩn RIP.
///
/// # Hai trục hỏng, không một trục
///
/// Gộp mọi cảnh báo vào một cờ duy nhất nghe an toàn nhưng lại **phá** chính mục
/// tiêu fail-loud. Một trang CMYK đặc đo đúng 400% mực vẫn thường mang theo một
/// nhãn chữ dùng font không nhúng; nếu nhãn đó bật cùng một cờ với "thiếu hẳn
/// shading", thì gần như mọi file xưởng thật đều bị hạ tin cậy và người dùng học
/// cách bỏ qua cảnh báo. Cảnh báo báo oan cũng vô dụng như không cảnh báo.
///
/// Vì thế cảnh báo tách theo **hệ quả với lượng mực**:
///
/// * [`Self::ink_unsound`] — có nội dung *đáng lẽ phải lên mực* mà chưa lên, hoặc
///   lên sai lượng: object bị bỏ, transparency chưa dựng, màu phải xấp xỉ, nội
///   dung có thể đang bị ẩn. Đỉnh TAC đo được **không** dùng để chốt kẽm.
/// * [`Self::geometry_approximate`] — nội dung *đã* lên mực nhưng hình khác bản
///   gốc (điển hình: font thay thế). Đỉnh mực của vùng đặc vẫn đúng; chỉ diện
///   tích phủ là xấp xỉ.
///
/// Ngoài hai trục đó, `skipped_ops` còn chứa mục **thuần thông tin** (`Q` không
/// cân, operator lạ mà §7.8.2 yêu cầu bỏ qua, font được khai trong resources
/// nhưng không có `Tj` nào dùng). Những mục này **không** hạ độ tin cậy: mọi
/// nhánh thực sự mất nội dung đều đã tự tăng `dropped_objects` hoặc bật
/// `unsupported_transparency` / `hidden_content_risk` tại đúng chỗ nó xảy ra.
#[derive(Debug, Default, Clone)]
pub struct RenderWarnings {
    /// Operator content stream engine bỏ qua (tên op → số lần).
    ///
    /// Danh sách này là **vết chẩn đoán**, không phải nguồn suy ra độ tin cậy.
    pub skipped_ops: Vec<(String, u32)>,
    /// Colorspace chưa hỗ trợ, đã phải xấp xỉ (ảnh hưởng trực tiếp tới lượng mực).
    pub approximated_colorspaces: Vec<String>,
    /// Số object vẽ bị bỏ (shading chưa hỗ trợ, ảnh không giải mã được…).
    pub dropped_objects: u32,
    /// Trang có transparency mà engine chưa dựng đủ (group/soft mask).
    pub unsupported_transparency: bool,
    /// Trang có optional content (`/OC`) mà engine chưa xét trạng thái bật/tắt.
    ///
    /// Tách riêng khỏi `dropped_objects` vì đây là rủi ro **ngược chiều**: nội
    /// dung đang tắt có thể đã bị vẽ lên kẽm, chứ không phải bị thiếu.
    pub hidden_content_risk: bool,
    /// Font không nhúng đã được thay bằng font khác để vẽ (tên font gốc).
    ///
    /// Chữ *có* lên mực, nên đỉnh TAC vùng đặc vẫn tin được; nhưng bề rộng và
    /// hình glyph khác bản gốc nên **diện tích phủ** chỉ là xấp xỉ.
    pub substituted_fonts: Vec<String>,
    /// Họ colorspace đã thực sự dùng để vẽ (thông tin, **không** phải cảnh báo).
    ///
    /// Cần cho hai việc: bộ đo golden biết file nào so được với Ghostscript (GS ở
    /// chế độ quản lý màu nén DeviceCMYK, PPE cố ý không), và lớp UI nói được vì
    /// sao một trang bị hạ `accuracy`.
    pub colorspaces_used: Vec<String>,
}

impl RenderWarnings {
    /// `true` khi **lượng mực đo được không đáng tin** — cấm chốt kẽm / kết luận
    /// "đạt ngưỡng mực" trên kết quả này.
    ///
    /// Đây là trục nghiêm ngặt: chỉ cần một object bị bỏ là đỉnh TAC có thể thấp
    /// hơn thực tế, đúng chiều sai làm hỏng lô in.
    pub fn ink_unsound(&self) -> bool {
        self.dropped_objects > 0
            || self.unsupported_transparency
            || self.hidden_content_risk
            || !self.approximated_colorspaces.is_empty()
    }

    /// `true` khi nội dung đã lên mực nhưng **hình học là xấp xỉ** (font thay thế).
    ///
    /// Đỉnh mực vùng đặc vẫn đúng; chỉ phần trăm diện tích phủ là ước lượng.
    pub fn geometry_approximate(&self) -> bool {
        !self.substituted_fonts.is_empty()
    }

    /// `true` nếu kết quả **không** được phép gắn nhãn chuẩn-RIP (hợp của hai trục).
    ///
    /// Giữ lại để lớp trên có một câu hỏi duy nhất khi chỉ cần biết "có sạch hay
    /// không". Muốn biết *hỏng kiểu gì* thì hỏi [`Self::ink_unsound`] /
    /// [`Self::geometry_approximate`].
    pub fn degrades_accuracy(&self) -> bool {
        self.ink_unsound() || self.geometry_approximate()
    }

    pub fn note_skipped_op(&mut self, op: &str) {
        if let Some(entry) = self.skipped_ops.iter_mut().find(|(name, _)| name == op) {
            entry.1 += 1;
        } else {
            self.skipped_ops.push((op.to_string(), 1));
        }
    }

    pub fn note_approximated_colorspace(&mut self, cs: &str) {
        if !self.approximated_colorspaces.iter().any(|c| c == cs) {
            self.approximated_colorspaces.push(cs.to_string());
        }
    }

    /// Ghi nhận một font không nhúng đã được thay để vẽ được chữ.
    pub fn note_substituted_font(&mut self, base_font: &str) {
        if !self.substituted_fonts.iter().any(|f| f == base_font) {
            self.substituted_fonts.push(base_font.to_string());
        }
    }

    /// Ghi nhận một họ colorspace đã dùng để vẽ.
    pub fn note_colorspace_used(&mut self, family: &str) {
        if !self.colorspaces_used.iter().any(|c| c == family) {
            self.colorspaces_used.push(family.to_string());
        }
    }
}
