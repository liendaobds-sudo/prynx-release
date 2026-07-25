//! Tách ảnh nội tuyến (`BI … ID … EI`) khỏi content stream trước khi tokenize.
//!
//! # Vì sao phải xử lý riêng
//!
//! Giữa `ID` và `EI` là **dữ liệu nhị phân thô**, không phải token PDF. Bộ
//! tokenize nào không biết điều đó sẽ đọc dữ liệu ảnh như toán tử, sinh ra rác
//! rồi bỏ luôn phần content còn lại của trang. Kết quả tệ nhất có thể xảy ra với
//! prepress: trang **trống một nửa** mà engine vẫn báo thành công.
//!
//! Nên đường an toàn là bóc các khối này ra trước, đếm lại, và để tầng trên hạ
//! `accuracy` nếu trang có ảnh nội tuyến chưa vẽ được.

/// Kết quả bóc ảnh nội tuyến.
pub struct StripResult {
    /// Content stream đã bỏ các khối `BI…EI`.
    pub data: Vec<u8>,
    /// Số khối đã bóc.
    pub count: u32,
}

/// Bóc mọi khối `BI … ID … EI`.
pub fn strip_inline_images(src: &[u8]) -> StripResult {
    let mut out = Vec::with_capacity(src.len());
    let mut count = 0u32;
    let mut i = 0usize;

    while i < src.len() {
        if is_token_at(src, i, b"BI") {
            match find_inline_image_end(src, i + 2) {
                Some(end) => {
                    count += 1;
                    i = end;
                    continue;
                }
                None => {
                    // Không tìm được `EI`: phần còn lại không đáng tin, dừng lại
                    // và báo có ảnh nội tuyến để accuracy bị hạ.
                    count += 1;
                    break;
                }
            }
        }
        out.push(src[i]);
        i += 1;
    }

    StripResult { data: out, count }
}

/// `true` nếu tại `pos` là token `tok` đứng độc lập (có ranh giới hai bên).
fn is_token_at(src: &[u8], pos: usize, tok: &[u8]) -> bool {
    if pos + tok.len() > src.len() || &src[pos..pos + tok.len()] != tok {
        return false;
    }
    let before_ok = pos == 0 || is_delimiter(src[pos - 1]);
    let after = src.get(pos + tok.len()).copied();
    let after_ok = after.map(is_delimiter).unwrap_or(true);
    before_ok && after_ok
}

fn is_delimiter(b: u8) -> bool {
    matches!(
        b,
        b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0' | b'/' | b'[' | b']' | b'<' | b'>' | b'(' | b')' | b'{' | b'}' | b'%'
    )
}

/// Tìm vị trí ngay sau `EI` của một khối ảnh nội tuyến bắt đầu sau `BI`.
fn find_inline_image_end(src: &[u8], from: usize) -> Option<usize> {
    // Bước 1: tìm `ID` — kết thúc phần dictionary.
    let mut i = from;
    let mut id_end = None;
    while i < src.len() {
        if is_token_at(src, i, b"ID") {
            id_end = Some(i + 2);
            break;
        }
        i += 1;
    }
    let mut i = id_end?;
    // Đúng MỘT byte trắng sau `ID` thuộc cú pháp, phần sau là dữ liệu.
    if i < src.len() && matches!(src[i], b' ' | b'\r' | b'\n' | b'\t') {
        i += 1;
    }

    // Bước 2: tìm `EI` có ranh giới. Dữ liệu nhị phân có thể chứa hai byte "EI"
    // ngẫu nhiên, nên đòi hỏi trước `EI` là khoảng trắng và sau nó là ranh giới —
    // đây là heuristic tiêu chuẩn, không có cách nào chắc chắn tuyệt đối vì độ
    // dài dữ liệu không được ghi trong cú pháp.
    while i < src.len() {
        if src[i] == b'E'
            && src.get(i + 1) == Some(&b'I')
            && i > 0
            && matches!(src[i - 1], b' ' | b'\r' | b'\n' | b'\t' | b'\0' | b'\x0c')
            && src.get(i + 2).copied().map(is_delimiter).unwrap_or(true)
        {
            return Some(i + 2);
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(s: &[u8]) -> (String, u32) {
        let r = strip_inline_images(s);
        (String::from_utf8_lossy(&r.data).into_owned(), r.count)
    }

    #[test]
    fn removes_inline_image_and_keeps_surrounding_ops() {
        let src = b"0 0 1 rg\nBI /W 2 /H 2 /BPC 8 /CS /G ID \x00\x01\x02\x03 EI\n10 10 re f\n";
        let (out, n) = strip(src);
        assert_eq!(n, 1);
        assert!(out.contains("0 0 1 rg"));
        assert!(out.contains("10 10 re f"), "phần sau ảnh phải còn: {out}");
        assert!(!out.contains("BI"));
    }

    #[test]
    fn handles_multiple_inline_images() {
        let src = b"BI /W 1 ID \x01 EI BI /W 1 ID \x02 EI 1 0 0 1 0 0 cm";
        let (out, n) = strip(src);
        assert_eq!(n, 2);
        assert!(out.contains("cm"));
    }

    #[test]
    fn binary_data_containing_ei_bytes_without_delimiter_is_not_a_false_end() {
        // "EI" dính liền byte khác ⇒ không phải kết thúc.
        let src = b"BI /W 1 ID \x01EIx\x02 EI 5 5 re f";
        let (out, n) = strip(src);
        assert_eq!(n, 1);
        assert!(out.contains("5 5 re f"), "out={out}");
    }

    #[test]
    fn unterminated_inline_image_is_reported_not_silently_kept() {
        // Không có `EI`: phải đếm là có ảnh (để hạ accuracy), không giả vờ ổn.
        let src = b"1 0 0 rg BI /W 1 ID \x01\x02\x03";
        let (out, n) = strip(src);
        assert_eq!(n, 1);
        assert!(out.contains("1 0 0 rg"));
    }

    #[test]
    fn content_without_inline_image_is_untouched() {
        let src = b"q 1 0 0 1 0 0 cm 0 0 10 10 re f Q";
        let (out, n) = strip(src);
        assert_eq!(n, 0);
        assert_eq!(out, String::from_utf8_lossy(src));
    }

    #[test]
    fn does_not_strip_operator_containing_bi_substring() {
        // `BI` phải là token độc lập; `BID` hay `BDC` không được coi là ảnh.
        let src = b"/Tag BDC 0 0 5 5 re f EMC";
        let (out, n) = strip(src);
        assert_eq!(n, 0);
        assert_eq!(out, String::from_utf8_lossy(src));
    }
}
