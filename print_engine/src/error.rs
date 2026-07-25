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
#[derive(Debug, Default, Clone)]
pub struct RenderWarnings {
    /// Operator content stream engine bỏ qua (tên op → số lần).
    pub skipped_ops: Vec<(String, u32)>,
    /// Colorspace chưa hỗ trợ, đã phải xấp xỉ.
    pub approximated_colorspaces: Vec<String>,
    /// Số object vẽ bị bỏ (font chưa hỗ trợ, shading chưa hỗ trợ…).
    pub dropped_objects: u32,
    /// Trang có transparency mà engine chưa dựng đủ (group/soft mask).
    pub unsupported_transparency: bool,
    /// Họ colorspace đã thực sự dùng để vẽ (thông tin, **không** phải cảnh báo).
    ///
    /// Cần cho hai việc: bộ đo golden biết file nào so được với Ghostscript (GS ở
    /// chế độ quản lý màu nén DeviceCMYK, PPE cố ý không), và lớp UI nói được vì
    /// sao một trang bị hạ `accuracy`.
    pub colorspaces_used: Vec<String>,
}

impl RenderWarnings {
    /// `true` nếu kết quả **không** được phép gắn nhãn chuẩn-RIP.
    pub fn degrades_accuracy(&self) -> bool {
        self.dropped_objects > 0
            || self.unsupported_transparency
            || !self.approximated_colorspaces.is_empty()
            || !self.skipped_ops.is_empty()
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

    /// Ghi nhận một họ colorspace đã dùng để vẽ.
    pub fn note_colorspace_used(&mut self, family: &str) {
        if !self.colorspaces_used.iter().any(|c| c == family) {
            self.colorspaces_used.push(family.to_string());
        }
    }
}
