//! Thu thập đường viền glyph để **ghi lại thành PDF**, không phải để rasterize.
//!
//! # Vì sao thứ này thuộc PPE thay vì viết lại bằng Python
//!
//! Action `OUTLINE_FONTS` (chuyển chữ thành vector) cần đúng ba thứ khó: đọc được
//! glyph của mọi loại font nhúng, hiểu encoding/CID để biết glyph nào ứng với mã
//! nào, và tính đúng ma trận chữ. PPE đã có cả ba và đã được đo song song với
//! Ghostscript qua bộ golden — bản Python trước đó viết lại chính những thứ đó bằng
//! fontTools và vấp đúng ở đó (tra glyph thất bại, Type3 chưa đụng tới).
//!
//! Phân chia: **Rust lo font/encoding/ma trận chữ**, **Python lo ghi PDF** bằng
//! pikepdf. Module này là mặt tiếp giáp giữa hai phần đó.
//!
//! # Không gian toạ độ — chỗ dễ sai nhất
//!
//! Path trả về nằm trong **không gian người dùng của chính content stream chứa
//! chữ**, tức chỉ áp ma trận chữ (`Tm` × `Tf` × `Trm`), **không** áp CTM của các
//! lệnh `cm`. Lý do: Python thay khối `BT … ET` **tại chỗ**, nên mọi `cm` đứng
//! trước vẫn còn hiệu lực và sẽ được người đọc PDF áp thêm một lần nữa. Nhân CTM
//! vào đây là nhân hai lần — đúng bug đã gặp ở §3.8 của kế hoạch, và nó chỉ lộ ra
//! trên trang **có** `cm`.

use tiny_skia::{Path, PathSegment};

/// Content stream chứa chữ.
///
/// Python cần biết ghi path vào stream nào; chỉ số thứ tự không đủ vì cùng một
/// Form XObject có thể được `Do` nhiều lần.
/// `Hash` + `Ord` để dùng làm khoá bảng đếm mã ký tự và để thứ tự báo cáo cố định
/// (báo cáo phải tái lập được: cùng file phải cho cùng chuỗi `blocks`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum StreamKey {
    /// Content stream của trang.
    Page,
    /// Form XObject, theo `ObjectId` của chính stream đó.
    Form(u32, u16),
    /// Stream không địa chỉ hoá được (form là object trực tiếp, không phải tham
    /// chiếu). Python không thể trỏ tới nó để ghi, nên chữ ở đây phải bị từ chối
    /// thay vì gán nhầm cho stream của trang.
    Unaddressable,
}

/// Mã lệnh đường dẫn, khớp thứ tự operator PDF (`m`, `l`, `c`, `h`).
pub mod verb {
    pub const MOVE: u8 = 0;
    pub const LINE: u8 = 1;
    pub const CUBIC: u8 = 2;
    pub const CLOSE: u8 = 3;
}

/// Một glyph đã được chuyển thành đường vector.
#[derive(Debug, Clone)]
pub struct GlyphOutline {
    pub stream: StreamKey,
    /// Thứ tự khối `BT … ET` trong stream (0-based).
    ///
    /// Dùng khối text làm mốc thay vì đếm mọi thao tác vẽ: Python thay **cả khối**
    /// `BT … ET`, nên mốc phải là thứ mà nó thay được. Đếm từng thao tác vẽ đòi
    /// Python phải phân tích lại toàn bộ stream để đồng bộ chỉ số.
    pub text_object_index: u32,
    /// Thứ tự **mã ký tự** trong khối text đó (0-based).
    ///
    /// Đếm mọi mã ký tự đi qua, kể cả dấu cách và `Tr 3`, nên chỉ số này khớp đúng
    /// vòng lặp mã ký tự của lớp ghi PDF bên Python. Chỉ đếm những glyph ghi được sẽ
    /// làm hai bên lệch ngay ở dấu cách đầu tiên và path bị gán cho glyph khác.
    pub glyph_index: u32,
    /// `Tr` cho phép tô, vẽ nét, gom clip — có thể đồng thời.
    pub fill: bool,
    pub stroke: bool,
    pub clip: bool,
    /// Bề rộng nét theo không gian người dùng, chỉ có nghĩa khi `stroke`.
    pub line_width: f32,
    /// Chuỗi mã lệnh (xem [`verb`]).
    pub verbs: Vec<u8>,
    /// Toạ độ đi kèm: MOVE/LINE 2 số, CUBIC 6 số, CLOSE 0 số.
    pub coords: Vec<f32>,
}

/// Số mã ký tự engine đã đi qua trong một khối `BT … ET`.
///
/// # Vì sao phải khai con số này ra
///
/// Lớp ghi PDF bên Python đi qua **cùng** content stream bằng một bộ code khác, nên
/// rủi ro thật không phải "path sai" mà là **lệch chỉ số**: path của glyph này bị gán
/// cho glyph khác. File vẫn mở được, vẫn có chữ, chỉ sai chỗ — và chỉ phát hiện khi
/// đã in.
///
/// Trước đây chốt duy nhất là hình học: so path với vị trí bút mà Python tự tính. Đo
/// được là chốt đó vừa loại oan (Python tính sai bước tiến trên file thật) vừa **bỏ
/// sót glyph nhỏ**: dấu chấm 12pt chỉ có 9 pixel mực nên lưới so kẽm theo ô không xét
/// tới, và chữ dịch 30pt vẫn báo hậu kiểm thành công.
///
/// So **số lượng** thì khác: nếu hai bên đếm ra cùng một số mã ký tự trong cùng một
/// khối, chỉ số của chúng khớp nhau theo cấu trúc — không phụ thuộc glyph to hay nhỏ,
/// không phụ thuộc ngưỡng nào.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextBlockCodes {
    pub stream: StreamKey,
    pub text_object_index: u32,
    /// Đếm MỌI mã ký tự đi qua, kể cả dấu cách, `Tr 3` và Type3.
    pub code_count: u32,
}

/// Kết quả thu thập của một trang.
#[derive(Debug, Clone, Default)]
pub struct TextOutlineReport {
    pub glyphs: Vec<GlyphOutline>,
    /// Số mã ký tự của từng khối `BT … ET` — hợp đồng đồng bộ chỉ số với lớp ghi PDF.
    pub blocks: Vec<TextBlockCodes>,
    /// Trang có font Type3.
    ///
    /// Glyph Type3 là **content stream**, không phải đường viền: nó có thể vẽ ảnh,
    /// đặt màu riêng, thậm chí vẽ chữ khác. Không có "outline" nào đúng cho nó, nên
    /// caller phải từ chối trang thay vì giao ra bản in thiếu chữ.
    pub has_type3: bool,
    /// Có chữ nằm trong soft mask hoặc ô tiling pattern.
    ///
    /// Những stream đó không phải chỗ Python thay khối `BT … ET`: chúng được dựng
    /// lại mỗi lần dùng và nằm trong dictionary tài nguyên, nên chỉ số khối text ở
    /// đó không ánh xạ được về chỗ ghi.
    pub has_unsupported_context: bool,
    /// Số glyph không tra được đường viền (font hỏng hoặc thiếu glyph).
    ///
    /// Bỏ qua âm thầm một glyph nghĩa là chữ **biến mất** khỏi bản in. Đã từng xảy
    /// ra ở bản Python (§3.8), nên con số này phải đi ra tới caller.
    pub missing_glyphs: u32,
}

impl TextOutlineReport {
    /// `true` nếu caller có thể tin toàn bộ báo cáo để ghi lại PDF.
    pub fn is_complete(&self) -> bool {
        !self.has_type3 && !self.has_unsupported_context && self.missing_glyphs == 0
    }
}

/// Đổi path của tiny-skia thành cặp `(verbs, coords)`.
///
/// Bậc hai được nâng lên bậc ba đúng công thức (`c1 = p0 + 2/3·(q − p0)`), vì PDF
/// không có operator bậc hai. Xấp xỉ bằng đường thẳng ở đây sẽ làm chữ TrueType
/// (vốn toàn bậc hai) mất độ mượt ngay ở kích thước in.
pub fn encode_path(path: &Path) -> (Vec<u8>, Vec<f32>) {
    let mut verbs = Vec::new();
    let mut coords = Vec::new();
    let mut cur = (0.0f32, 0.0f32);
    for seg in path.segments() {
        match seg {
            PathSegment::MoveTo(p) => {
                verbs.push(verb::MOVE);
                coords.extend_from_slice(&[p.x, p.y]);
                cur = (p.x, p.y);
            }
            PathSegment::LineTo(p) => {
                verbs.push(verb::LINE);
                coords.extend_from_slice(&[p.x, p.y]);
                cur = (p.x, p.y);
            }
            PathSegment::QuadTo(q, p) => {
                let c1 = (
                    cur.0 + 2.0 / 3.0 * (q.x - cur.0),
                    cur.1 + 2.0 / 3.0 * (q.y - cur.1),
                );
                let c2 = (p.x + 2.0 / 3.0 * (q.x - p.x), p.y + 2.0 / 3.0 * (q.y - p.y));
                verbs.push(verb::CUBIC);
                coords.extend_from_slice(&[c1.0, c1.1, c2.0, c2.1, p.x, p.y]);
                cur = (p.x, p.y);
            }
            PathSegment::CubicTo(c1, c2, p) => {
                verbs.push(verb::CUBIC);
                coords.extend_from_slice(&[c1.x, c1.y, c2.x, c2.y, p.x, p.y]);
                cur = (p.x, p.y);
            }
            PathSegment::Close => verbs.push(verb::CLOSE),
        }
    }
    (verbs, coords)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiny_skia::PathBuilder;

    #[test]
    fn encodes_lines_and_close() {
        let mut b = PathBuilder::new();
        b.move_to(0.0, 0.0);
        b.line_to(10.0, 0.0);
        b.line_to(10.0, 10.0);
        b.close();
        let path = b.finish().unwrap();
        let (verbs, coords) = encode_path(&path);
        assert_eq!(verbs, vec![verb::MOVE, verb::LINE, verb::LINE, verb::CLOSE]);
        assert_eq!(coords, vec![0.0, 0.0, 10.0, 0.0, 10.0, 10.0]);
    }

    #[test]
    fn raises_quadratic_to_cubic_instead_of_flattening() {
        // Chữ TrueType toàn bậc hai. Nếu bước này hạ thành đường thẳng thì chữ mất
        // độ mượt ngay ở kích thước in, mà không test nào khác bắt được.
        let mut b = PathBuilder::new();
        b.move_to(0.0, 0.0);
        b.quad_to(6.0, 0.0, 6.0, 6.0);
        let path = b.finish().unwrap();
        let (verbs, coords) = encode_path(&path);
        assert_eq!(verbs, vec![verb::MOVE, verb::CUBIC]);
        // c1 = p0 + 2/3·(q − p0) = (4, 0); c2 = p3 + 2/3·(q − p3) = (6, 2)
        assert!((coords[2] - 4.0).abs() < 1e-4, "{coords:?}");
        assert!((coords[3] - 0.0).abs() < 1e-4, "{coords:?}");
        assert!((coords[4] - 6.0).abs() < 1e-4, "{coords:?}");
        assert!((coords[5] - 2.0).abs() < 1e-4, "{coords:?}");
        assert!((coords[6] - 6.0).abs() < 1e-4, "{coords:?}");
        assert!((coords[7] - 6.0).abs() < 1e-4, "{coords:?}");
    }

    #[test]
    fn report_is_incomplete_when_anything_was_dropped() {
        let mut r = TextOutlineReport::default();
        assert!(r.is_complete());
        r.missing_glyphs = 1;
        assert!(!r.is_complete());
    }
}
