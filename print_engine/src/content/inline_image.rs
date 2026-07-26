//! Ảnh nội tuyến (`BI … ID … EI`) — bóc ra khỏi content stream và dựng lại thành
//! image XObject tương đương.
//!
//! # Vì sao phải xử lý riêng
//!
//! Giữa `ID` và `EI` là **dữ liệu nhị phân thô**, không phải token PDF. Bộ tokenize
//! nào không biết điều đó sẽ đọc dữ liệu ảnh như toán tử, sinh ra rác rồi bỏ luôn
//! phần content còn lại của trang. Kết quả tệ nhất có thể xảy ra với prepress: trang
//! **trống một nửa** mà engine vẫn báo thành công.
//!
//! # Cách nối vào engine
//!
//! Khối `BI…EI` được thay bằng một operator tổng hợp `{i} PPEinline`, và ảnh được
//! dựng thành `Object::Stream` với dictionary **đã đổi tên khoá viết tắt** về dạng
//! đầy đủ. Nhờ vậy `decode_image` dùng lại y nguyên: cùng chuỗi filter, cùng
//! predictor, cùng `/Decode`, cùng đường quy đổi màu. Không có nhánh mã thứ hai cho
//! ảnh nội tuyến, nên không có chỗ để hai đường lệch ngữ nghĩa.
//!
//! # Xác định độ dài dữ liệu
//!
//! Cú pháp PDF **không** ghi độ dài dữ liệu ảnh nội tuyến (trừ `/L` của PDF 2.0).
//! Dò `EI` bằng heuristic là cách phổ biến nhưng có thể sai vì dữ liệu nhị phân chứa
//! đúng hai byte `EI` giữa hai khoảng trắng. Nên module này **tính trước** độ dài khi
//! ảnh không nén (từ `/W`, `/H`, `/BPC`, số kênh của `/CS`) và chỉ lùi về heuristic
//! khi không tính được. Với ảnh không nén, sai một byte làm lệch cả ảnh.

use lopdf::{Dictionary, Object, Stream};

/// Kết quả bóc ảnh nội tuyến.
pub struct ExtractResult {
    /// Content stream với mỗi khối `BI…EI` thay bằng `{i} PPEinline`.
    pub data: Vec<u8>,
    /// Ảnh đã dựng lại, theo thứ tự xuất hiện. Chỉ số `i` khớp toán hạng operator.
    pub images: Vec<Object>,
    /// Số khối **không** dựng lại được (dict hỏng, không tìm được `EI`).
    pub failed: u32,
}

/// Tên operator tổng hợp thay cho `BI…EI`.
///
/// Chọn một tên không tồn tại trong ISO 32000 để không thể trùng operator thật.
pub const INLINE_OP: &str = "PPEinline";

/// Bóc mọi khối `BI … ID … EI` và dựng lại thành image XObject.
pub fn extract_inline_images(src: &[u8]) -> ExtractResult {
    let mut out = Vec::with_capacity(src.len());
    let mut images = Vec::new();
    let mut failed = 0u32;
    let mut i = 0usize;

    while i < src.len() {
        if is_token_at(src, i, b"BI") {
            match parse_inline_image(src, i + 2) {
                Some((dict, data, end)) => {
                    let index = images.len();
                    images.push(Object::Stream(Stream::new(dict, data)));
                    out.extend_from_slice(format!(" {index} {INLINE_OP} ").as_bytes());
                    i = end;
                    continue;
                }
                None => {
                    // Dict hỏng hoặc không tìm được `EI`. Bỏ khối và **đếm**: phần
                    // còn lại của stream sau một `EI` không xác định là không đáng
                    // tin, nhưng bỏ im lặng thì trang sẽ báo sạch.
                    failed += 1;
                    match find_inline_image_end(src, i + 2) {
                        Some(end) => {
                            i = end;
                            continue;
                        }
                        None => break,
                    }
                }
            }
        }
        out.push(src[i]);
        i += 1;
    }

    ExtractResult {
        data: out,
        images,
        failed,
    }
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
        b' ' | b'\t'
            | b'\r'
            | b'\n'
            | b'\x0c'
            | b'\0'
            | b'/'
            | b'['
            | b']'
            | b'<'
            | b'>'
            | b'('
            | b')'
            | b'{'
            | b'}'
            | b'%'
    )
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0')
}

/// Đọc một khối ảnh nội tuyến bắt đầu ngay sau `BI`.
///
/// Trả `(dictionary đã chuẩn hoá, dữ liệu thô, vị trí ngay sau EI)`.
fn parse_inline_image(src: &[u8], from: usize) -> Option<(Dictionary, Vec<u8>, usize)> {
    let mut lex = Lexer { src, pos: from };
    let mut dict = Dictionary::new();

    // Dictionary: các cặp `/Key value` tới khi gặp keyword `ID`.
    loop {
        lex.skip_ws();
        match lex.peek()? {
            b'/' => {
                let key = lex.parse_name()?;
                lex.skip_ws();
                let value = lex.parse_object()?;
                dict.set(expand_key(&key), expand_value(&key, value));
            }
            _ => {
                let kw = lex.parse_keyword()?;
                if kw == "ID" {
                    break;
                }
                // Token lạ trong dict ⇒ không tin được cấu trúc.
                return None;
            }
        }
    }

    // Đúng MỘT byte trắng sau `ID` thuộc cú pháp; byte thứ hai đã là dữ liệu.
    let mut pos = lex.pos;
    if pos < src.len() && is_ws(src[pos]) {
        pos += 1;
    }

    // Ưu tiên độ dài tính được / khai tường minh, rồi mới tới heuristic.
    if let Some(len) = declared_length(&dict).or_else(|| computed_length(&dict)) {
        let end = pos.checked_add(len)?;
        if end <= src.len() {
            let mut after = end;
            while after < src.len() && is_ws(src[after]) {
                after += 1;
            }
            if src.get(after) == Some(&b'E') && src.get(after + 1) == Some(&b'I') {
                return Some((dict, src[pos..end].to_vec(), after + 2));
            }
        }
    }

    let end = find_inline_image_end(src, from)?;
    // `end` trỏ ngay sau `EI`; lùi lại để lấy phần dữ liệu.
    let mut data_end = end.saturating_sub(2);
    while data_end > pos && is_ws(src[data_end - 1]) {
        data_end -= 1;
    }
    Some((dict, src[pos..data_end].to_vec(), end))
}

/// `/L` hoặc `/Length` — PDF 2.0 cho phép khai tường minh.
fn declared_length(dict: &Dictionary) -> Option<usize> {
    let obj = dict.get(b"Length").ok()?;
    match obj {
        Object::Integer(n) if *n >= 0 => Some(*n as usize),
        _ => None,
    }
}

/// Độ dài dữ liệu của ảnh **không nén**, tính từ khai báo.
///
/// `None` khi có filter (độ dài phụ thuộc dữ liệu nén) hoặc khi không suy được số
/// kênh — ví dụ `/CS` trỏ tới một colorspace đặt tên trong `/Resources`.
fn computed_length(dict: &Dictionary) -> Option<usize> {
    if dict.get(b"Filter").is_ok() {
        return None;
    }
    let w = int_of(dict, b"Width")? as usize;
    let h = int_of(dict, b"Height")? as usize;
    let is_mask = matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true)));
    let bpc = if is_mask {
        1
    } else {
        int_of(dict, b"BitsPerComponent").unwrap_or(8) as usize
    };
    let n = if is_mask { 1 } else { components(dict)? };
    if w == 0 || h == 0 || bpc == 0 || n == 0 {
        return None;
    }
    // Mỗi **hàng** được đệm lên biên byte (§8.9.3), không phải cả ảnh.
    let row_bits = w.checked_mul(n)?.checked_mul(bpc)?;
    let row_bytes = row_bits.div_ceil(8);
    row_bytes.checked_mul(h)
}

/// Số kênh từ `/ColorSpace`, chỉ với các device space biết chắc.
fn components(dict: &Dictionary) -> Option<usize> {
    let cs = dict.get(b"ColorSpace").ok()?;
    let name = match cs {
        Object::Name(n) => String::from_utf8_lossy(n).into_owned(),
        _ => return None,
    };
    match name.as_str() {
        "DeviceGray" | "CalGray" => Some(1),
        "DeviceRGB" | "CalRGB" => Some(3),
        "DeviceCMYK" => Some(4),
        // Indexed: mỗi mẫu là một chỉ số ⇒ một kênh. Nhưng dạng mảng không tới đây.
        _ => None,
    }
}

fn int_of(dict: &Dictionary, key: &[u8]) -> Option<i64> {
    match dict.get(key).ok()? {
        Object::Integer(n) => Some(*n),
        Object::Real(f) => Some(*f as i64),
        _ => None,
    }
}

/// Đổi khoá viết tắt của ảnh nội tuyến về tên đầy đủ.
///
/// Làm ở đây, một lần, thay vì bắt mọi chỗ đọc dictionary phải biết cả hai dạng.
fn expand_key(key: &str) -> &str {
    match key {
        "W" => "Width",
        "H" => "Height",
        "BPC" => "BitsPerComponent",
        "CS" => "ColorSpace",
        "F" => "Filter",
        "DP" => "DecodeParms",
        "D" => "Decode",
        "IM" => "ImageMask",
        "I" => "Interpolate",
        "L" => "Length",
        other => other,
    }
}

/// Đổi tên viết tắt của **giá trị** (colorspace và filter) về tên đầy đủ.
fn expand_value(key: &str, value: Object) -> Object {
    let map: fn(&str) -> Option<&'static str> = match key {
        "CS" | "ColorSpace" => colorspace_alias,
        "F" | "Filter" => filter_alias,
        _ => return value,
    };
    expand_names(value, map)
}

fn expand_names(value: Object, map: fn(&str) -> Option<&'static str>) -> Object {
    match value {
        Object::Name(ref n) => {
            let s = String::from_utf8_lossy(n).into_owned();
            match map(&s) {
                Some(full) => Object::Name(full.as_bytes().to_vec()),
                None => value,
            }
        }
        Object::Array(items) => {
            Object::Array(items.into_iter().map(|o| expand_names(o, map)).collect())
        }
        other => other,
    }
}

fn colorspace_alias(name: &str) -> Option<&'static str> {
    match name {
        "G" => Some("DeviceGray"),
        "RGB" => Some("DeviceRGB"),
        "CMYK" => Some("DeviceCMYK"),
        "I" => Some("Indexed"),
        _ => None,
    }
}

fn filter_alias(name: &str) -> Option<&'static str> {
    match name {
        "AHx" => Some("ASCIIHexDecode"),
        "A85" => Some("ASCII85Decode"),
        "LZW" => Some("LZWDecode"),
        "Fl" => Some("FlateDecode"),
        "RL" => Some("RunLengthDecode"),
        "CCF" => Some("CCITTFaxDecode"),
        "DCT" => Some("DCTDecode"),
        _ => None,
    }
}

/// Tìm vị trí ngay sau `EI` bằng heuristic (đường lùi khi không tính được độ dài).
fn find_inline_image_end(src: &[u8], from: usize) -> Option<usize> {
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
    if i < src.len() && is_ws(src[i]) {
        i += 1;
    }

    // Dữ liệu nhị phân có thể chứa hai byte "EI" ngẫu nhiên, nên đòi hỏi trước `EI`
    // là khoảng trắng và sau nó là ranh giới. Không có cách nào chắc chắn tuyệt đối
    // vì độ dài không nằm trong cú pháp — đó chính là lý do đường tính trước ở
    // `computed_length` được ưu tiên.
    while i < src.len() {
        if src[i] == b'E'
            && src.get(i + 1) == Some(&b'I')
            && i > 0
            && is_ws(src[i - 1])
            && src.get(i + 2).copied().map(is_delimiter).unwrap_or(true)
        {
            return Some(i + 2);
        }
        i += 1;
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bộ đọc object tối giản cho dictionary của ảnh nội tuyến
// ─────────────────────────────────────────────────────────────────────────────

/// Trần độ sâu lồng của mảng / dictionary trong dict ảnh nội tuyến.
const MAX_NEST: u32 = 16;

struct Lexer<'a> {
    src: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if is_ws(b) {
                self.pos += 1;
            } else if b == b'%' {
                // Chú thích chạy tới hết dòng.
                while let Some(c) = self.peek() {
                    self.pos += 1;
                    if c == b'\n' || c == b'\r' {
                        break;
                    }
                }
            } else {
                break;
            }
        }
    }

    fn parse_object(&mut self) -> Option<Object> {
        self.parse_object_depth(0)
    }

    fn parse_object_depth(&mut self, depth: u32) -> Option<Object> {
        if depth > MAX_NEST {
            return None;
        }
        self.skip_ws();
        match self.peek()? {
            b'/' => Some(Object::Name(self.parse_name()?.into_bytes())),
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_ws();
                    match self.peek()? {
                        b']' => {
                            self.pos += 1;
                            return Some(Object::Array(items));
                        }
                        _ => items.push(self.parse_object_depth(depth + 1)?),
                    }
                }
            }
            b'<' if self.src.get(self.pos + 1) == Some(&b'<') => {
                self.pos += 2;
                let mut dict = Dictionary::new();
                loop {
                    self.skip_ws();
                    if self.peek()? == b'>' {
                        if self.src.get(self.pos + 1) == Some(&b'>') {
                            self.pos += 2;
                            return Some(Object::Dictionary(dict));
                        }
                        return None;
                    }
                    let key = self.parse_name()?;
                    let value = self.parse_object_depth(depth + 1)?;
                    dict.set(key, value);
                }
            }
            b'<' => self.parse_hex_string(),
            b'(' => self.parse_literal_string(),
            b'+' | b'-' | b'.' | b'0'..=b'9' => self.parse_number(),
            _ => {
                let kw = self.parse_keyword()?;
                match kw.as_str() {
                    "true" => Some(Object::Boolean(true)),
                    "false" => Some(Object::Boolean(false)),
                    "null" => Some(Object::Null),
                    _ => None,
                }
            }
        }
    }

    /// Tên PDF, đã giải mã `#xx`.
    fn parse_name(&mut self) -> Option<String> {
        if self.peek()? != b'/' {
            return None;
        }
        self.pos += 1;
        let mut out = Vec::new();
        while let Some(b) = self.peek() {
            if is_delimiter(b) {
                break;
            }
            if b == b'#' {
                let hi = hex_val(*self.src.get(self.pos + 1)?)?;
                let lo = hex_val(*self.src.get(self.pos + 2)?)?;
                out.push(hi * 16 + lo);
                self.pos += 3;
            } else {
                out.push(b);
                self.pos += 1;
            }
        }
        Some(String::from_utf8_lossy(&out).into_owned())
    }

    fn parse_number(&mut self) -> Option<Object> {
        let start = self.pos;
        let mut is_real = false;
        while let Some(b) = self.peek() {
            match b {
                b'0'..=b'9' | b'+' | b'-' => self.pos += 1,
                b'.' => {
                    is_real = true;
                    self.pos += 1;
                }
                _ => break,
            }
        }
        let text = std::str::from_utf8(&self.src[start..self.pos]).ok()?;
        if is_real {
            text.parse::<f32>().ok().map(Object::Real)
        } else {
            text.parse::<i64>().ok().map(Object::Integer)
        }
    }

    fn parse_keyword(&mut self) -> Option<String> {
        let start = self.pos;
        while let Some(b) = self.peek() {
            if is_delimiter(b) {
                break;
            }
            self.pos += 1;
        }
        if self.pos == start {
            return None;
        }
        Some(String::from_utf8_lossy(&self.src[start..self.pos]).into_owned())
    }

    fn parse_hex_string(&mut self) -> Option<Object> {
        self.pos += 1; // '<'
        let mut nibbles = Vec::new();
        while let Some(b) = self.peek() {
            self.pos += 1;
            if b == b'>' {
                break;
            }
            if let Some(v) = hex_val(b) {
                nibbles.push(v);
            }
        }
        if nibbles.len() % 2 == 1 {
            nibbles.push(0);
        }
        let bytes: Vec<u8> = nibbles.chunks(2).map(|c| c[0] * 16 + c[1]).collect();
        Some(Object::String(bytes, lopdf::StringFormat::Hexadecimal))
    }

    fn parse_literal_string(&mut self) -> Option<Object> {
        self.pos += 1; // '('
        let mut out = Vec::new();
        let mut nesting = 1usize;
        while let Some(b) = self.peek() {
            self.pos += 1;
            match b {
                b'\\' => {
                    let esc = self.peek()?;
                    self.pos += 1;
                    out.push(match esc {
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b'b' => 8,
                        b'f' => 12,
                        other => other,
                    });
                }
                b'(' => {
                    nesting += 1;
                    out.push(b);
                }
                b')' => {
                    nesting -= 1;
                    if nesting == 0 {
                        return Some(Object::String(out, lopdf::StringFormat::Literal));
                    }
                    out.push(b);
                }
                other => out.push(other),
            }
        }
        None
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(s: &[u8]) -> (String, ExtractResult) {
        let r = extract_inline_images(s);
        (String::from_utf8_lossy(&r.data).into_owned(), r)
    }

    fn stream_of(r: &ExtractResult, i: usize) -> &Stream {
        match &r.images[i] {
            Object::Stream(s) => s,
            _ => panic!("phải là stream"),
        }
    }

    #[test]
    fn replaces_inline_image_with_synthetic_operator() {
        let src = b"0 0 1 rg\nBI /W 2 /H 2 /BPC 8 /CS /G ID \x00\x01\x02\x03 EI\n10 10 re f\n";
        let (out, r) = extract(src);
        assert_eq!(r.images.len(), 1);
        assert_eq!(r.failed, 0);
        assert!(out.contains("0 0 1 rg"));
        assert!(out.contains("0 PPEinline"), "out={out}");
        assert!(out.contains("10 10 re f"), "phần sau ảnh phải còn: {out}");
        assert!(!out.contains("BI"));
    }

    #[test]
    fn abbreviated_keys_are_expanded_to_full_names() {
        // Đổi tên ở một chỗ duy nhất là điều kiện để `decode_image` dùng lại được.
        let src = b"BI /W 1 /H 1 /BPC 8 /CS /RGB /D [0 1 0 1 0 1] ID \x10\x20\x30 EI";
        let (_, r) = extract(src);
        let d = &stream_of(&r, 0).dict;
        assert_eq!(d.get(b"Width").unwrap().as_i64().unwrap(), 1);
        assert_eq!(d.get(b"Height").unwrap().as_i64().unwrap(), 1);
        assert_eq!(d.get(b"BitsPerComponent").unwrap().as_i64().unwrap(), 8);
        assert!(d.get(b"Decode").is_ok(), "/D phải thành /Decode");
    }

    #[test]
    fn colorspace_and_filter_aliases_are_expanded() {
        let src = b"BI /W 1 /H 1 /CS /CMYK /F /Fl ID \x01\x02 EI";
        let (_, r) = extract(src);
        let d = &stream_of(&r, 0).dict;
        assert_eq!(
            d.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceCMYK"
        );
        assert_eq!(d.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");
    }

    #[test]
    fn filter_alias_inside_array_is_expanded() {
        let src = b"BI /W 1 /H 1 /CS /G /F [/A85 /Fl] ID zzz EI";
        let (_, r) = extract(src);
        let arr = stream_of(&r, 0)
            .dict
            .get(b"Filter")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(arr[0].as_name().unwrap(), b"ASCII85Decode");
        assert_eq!(arr[1].as_name().unwrap(), b"FlateDecode");
    }

    #[test]
    fn uncompressed_length_is_computed_not_guessed() {
        // Dữ liệu chứa đúng chuỗi " EI " ở giữa. Heuristic sẽ cắt sớm; đường tính
        // trước phải lấy đủ 8 byte. Đây là lý do `computed_length` tồn tại.
        let mut src: Vec<u8> = b"BI /W 8 /H 1 /BPC 8 /CS /G ID ".to_vec();
        src.extend_from_slice(&[0x01, 0x20, b'E', b'I', 0x20, 0x05, 0x06, 0x07]);
        src.extend_from_slice(b" EI 1 0 0 1 0 0 cm");
        let (out, r) = extract(&src);
        assert_eq!(r.failed, 0);
        assert_eq!(stream_of(&r, 0).content.len(), 8, "phải lấy đúng 8 byte");
        assert!(out.contains("cm"), "out={out}");
    }

    #[test]
    fn row_padding_is_per_row_not_per_image() {
        // 3 pixel × 1 bit = 3 bit ⇒ mỗi HÀNG một byte ⇒ 2 byte cho 2 hàng.
        // Đệm theo cả ảnh sẽ ra 1 byte và làm lệch hàng thứ hai.
        let mut src: Vec<u8> = b"BI /W 3 /H 2 /BPC 1 /IM true ID ".to_vec();
        src.extend_from_slice(&[0b1010_0000, 0b0100_0000]);
        src.extend_from_slice(b" EI");
        let (_, r) = extract(&src);
        assert_eq!(stream_of(&r, 0).content.len(), 2);
    }

    #[test]
    fn explicit_length_key_is_honoured() {
        let mut src: Vec<u8> = b"BI /W 4 /H 1 /CS /G /F /Fl /L 5 ID ".to_vec();
        src.extend_from_slice(&[1, 2, 3, 4, 5]);
        src.extend_from_slice(b" EI");
        let (_, r) = extract(&src);
        assert_eq!(stream_of(&r, 0).content.len(), 5);
    }

    #[test]
    fn handles_multiple_inline_images_with_distinct_indices() {
        let src = b"BI /W 1 /H 1 /BPC 8 /CS /G ID \x01 EI BI /W 1 /H 1 /BPC 8 /CS /G ID \x02 EI 1 0 0 1 0 0 cm";
        let (out, r) = extract(src);
        assert_eq!(r.images.len(), 2);
        assert!(out.contains("0 PPEinline"), "out={out}");
        assert!(out.contains("1 PPEinline"), "out={out}");
        assert!(out.contains("cm"));
        assert_eq!(stream_of(&r, 0).content, vec![1]);
        assert_eq!(stream_of(&r, 1).content, vec![2]);
    }

    #[test]
    fn compressed_image_falls_back_to_ei_scan() {
        // Có filter ⇒ không tính được độ dài ⇒ dò `EI`.
        let src = b"BI /W 4 /H 4 /BPC 8 /CS /G /F /AHx ID 00112233 EI 5 5 re f";
        let (out, r) = extract(src);
        assert_eq!(r.failed, 0);
        assert_eq!(stream_of(&r, 0).content, b"00112233".to_vec());
        assert!(out.contains("5 5 re f"));
    }

    #[test]
    fn binary_data_containing_ei_bytes_without_delimiter_is_not_a_false_end() {
        let src = b"BI /W 1 /H 1 /BPC 8 /CS /G /F /RL ID \x01EIx\x02 EI 5 5 re f";
        let (out, r) = extract(src);
        assert_eq!(r.images.len(), 1);
        assert!(out.contains("5 5 re f"), "out={out}");
    }

    #[test]
    fn unterminated_inline_image_is_reported_not_silently_kept() {
        let src = b"1 0 0 rg BI /W 1 /H 1 /CS /G /F /Fl ID \x01\x02\x03";
        let (out, r) = extract(src);
        assert_eq!(r.failed, 1, "phải đếm là thất bại");
        assert!(r.images.is_empty());
        assert!(out.contains("1 0 0 rg"));
    }

    #[test]
    fn malformed_dictionary_is_counted_as_failure() {
        // Token lạ trong dict (không phải `/Key value` cũng không phải `ID`).
        let src = b"BI 42 /W 1 ID \x01 EI";
        let (_, r) = extract(src);
        assert_eq!(r.failed, 1);
        assert!(r.images.is_empty());
    }

    #[test]
    fn content_without_inline_image_is_untouched() {
        let src = b"q 1 0 0 1 0 0 cm 0 0 10 10 re f Q";
        let (out, r) = extract(src);
        assert_eq!(r.images.len(), 0);
        assert_eq!(r.failed, 0);
        assert_eq!(out, String::from_utf8_lossy(src));
    }

    #[test]
    fn does_not_treat_operator_containing_bi_substring_as_image() {
        let src = b"/Tag BDC 0 0 5 5 re f EMC";
        let (out, r) = extract(src);
        assert_eq!(r.images.len(), 0);
        assert_eq!(out, String::from_utf8_lossy(src));
    }

    #[test]
    fn nested_dictionary_value_is_parsed() {
        // `/DP` của LZW/Flate là một dictionary lồng.
        let src = b"BI /W 4 /H 1 /BPC 8 /CS /G /F /Fl /DP << /Predictor 12 /Colors 1 >> ID zz EI";
        let (_, r) = extract(src);
        let dp = stream_of(&r, 0).dict.get(b"DecodeParms").unwrap();
        let dp = dp.as_dict().unwrap();
        assert_eq!(dp.get(b"Predictor").unwrap().as_i64().unwrap(), 12);
    }

    #[test]
    fn hex_encoded_name_is_decoded() {
        let src = b"BI /W 1 /H 1 /BPC 8 /CS /PANTONE#20485 ID \x01 EI";
        let (_, r) = extract(src);
        assert_eq!(
            stream_of(&r, 0)
                .dict
                .get(b"ColorSpace")
                .unwrap()
                .as_name()
                .unwrap(),
            "PANTONE 485".as_bytes()
        );
    }

    #[test]
    fn comment_inside_dictionary_is_skipped() {
        let src = b"BI /W 1 % chu thich\n /H 1 /BPC 8 /CS /G ID \x01 EI";
        let (_, r) = extract(src);
        assert_eq!(r.failed, 0);
        assert_eq!(
            stream_of(&r, 0)
                .dict
                .get(b"Height")
                .unwrap()
                .as_i64()
                .unwrap(),
            1
        );
    }
}
