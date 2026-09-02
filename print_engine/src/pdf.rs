//! Tiện ích đọc object PDF.
//!
//! Gom mọi phép giải tham chiếu (`Reference`) và đọc số/tên vào một chỗ. Lý do:
//! trong PDF gần như **mọi** giá trị đều có thể là tham chiếu gián tiếp, kể cả
//! một con số trong mảng. Rải `dereference` khắp interpreter là nguồn bug im
//! lặng (đọc ra 0 rồi vẽ sai) khó truy nhất.

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use crate::image::filters::{apply_predictor, asciihex_decode, PredictorParams};

/// Trần độ sâu giải tham chiếu, chống PDF có vòng lặp tham chiếu.
const MAX_DEREF_DEPTH: u32 = 32;

/// Giải tham chiếu gián tiếp về object thật.
pub fn deref<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
    let mut cur = obj;
    for _ in 0..MAX_DEREF_DEPTH {
        match cur {
            Object::Reference(id) => match doc.get_object(*id) {
                Ok(next) => cur = next,
                Err(_) => return &Object::Null,
            },
            _ => return cur,
        }
    }
    &Object::Null
}

/// Đọc số thực, chấp nhận cả Integer và Real.
pub fn as_num(obj: &Object) -> Option<f32> {
    match obj {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        _ => None,
    }
}

/// Đọc số thực sau khi giải tham chiếu.
pub fn num(doc: &Document, obj: &Object) -> Option<f32> {
    as_num(deref(doc, obj))
}

/// Đọc tên (`/Name`) thành `String`, bỏ tiền tố `/`.
///
/// Tên trong PDF có thể chứa escape `#XX` (ISO 32000-2 §7.3.5) — ví dụ
/// `/PANTONE#20485#20C` là `PANTONE 485 C`. Không decode thì tên spot sẽ sai và
/// việc so tên kênh bế (`CutContour`) sẽ trượt.
pub fn name_str(obj: &Object) -> Option<String> {
    let raw = match obj {
        Object::Name(n) => n,
        _ => return None,
    };
    Some(decode_pdf_name(raw))
}

/// Decode escape `#XX` trong tên PDF.
pub fn decode_pdf_name(raw: &[u8]) -> String {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'#' && i + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Đọc mảng số (đã giải tham chiếu từng phần tử).
pub fn num_array(doc: &Document, obj: &Object) -> Option<Vec<f32>> {
    let arr = deref(doc, obj).as_array().ok()?;
    Some(arr.iter().filter_map(|o| num(doc, o)).collect())
}

/// Lấy một khoá trong dictionary rồi giải tham chiếu.
pub fn dict_get<'a>(doc: &'a Document, dict: &'a Dictionary, key: &str) -> Option<&'a Object> {
    let raw = dict.get(key.as_bytes()).ok()?;
    let resolved = deref(doc, raw);
    if matches!(resolved, Object::Null) {
        None
    } else {
        Some(resolved)
    }
}

/// Lấy dictionary con — chấp nhận cả `Dictionary` và `Stream` (stream có dict).
pub fn dict_get_dict<'a>(
    doc: &'a Document,
    dict: &'a Dictionary,
    key: &str,
) -> Option<&'a Dictionary> {
    match dict_get(doc, dict, key)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

/// Chất lượng bytes sau khi đọc một PDF stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeQuality {
    /// Chuỗi filter được giải mã trọn vẹn.
    Exact,
    /// Decoder lỗi; bytes là output cứu được hoặc payload raw để tương thích.
    Recovered,
}

/// Bytes stream đi cùng provenance, để caller không biến recovery thành kết quả sạch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedStream {
    pub bytes: Vec<u8>,
    pub quality: DecodeQuality,
}

fn unsigned_param(doc: &Document, dict: &Dictionary, key: &str, default: usize) -> Option<usize> {
    let Ok(raw) = dict.get(key.as_bytes()) else {
        return Some(default);
    };
    // Các trường DecodeParms này là integer theo PDF. Không đi qua `f32`:
    // trên 2^24, làm tròn có thể đổi kích thước hàng rồi cấp Exact sai.
    let Object::Integer(value) = deref(doc, raw) else {
        return None;
    };
    usize::try_from(*value).ok()
}

fn predictor_params(doc: &Document, obj: &Object) -> Option<PredictorParams> {
    let Object::Dictionary(dict) = deref(doc, obj) else {
        return None;
    };
    let predictor = unsigned_param(doc, dict, "Predictor", 1)?;
    let colors = unsigned_param(doc, dict, "Colors", 1)?;
    let bits_per_component = unsigned_param(doc, dict, "BitsPerComponent", 8)?;
    let columns = unsigned_param(doc, dict, "Columns", 1)?;
    let early_change = unsigned_param(doc, dict, "EarlyChange", 1)?;
    if !matches!(predictor, 1 | 2 | 10..=15)
        || colors == 0
        || !matches!(bits_per_component, 1 | 2 | 4 | 8 | 16)
        || columns == 0
        || early_change > 1
        // Helper TIFF legacy chỉ chứng minh đúng phép cộng theo byte 8-bit.
        || (predictor == 2 && bits_per_component != 8)
    {
        return None;
    }
    Some(PredictorParams {
        predictor: predictor as u8,
        colors,
        bits_per_component,
        columns,
        early_change: early_change == 1,
    })
}

fn stream_filters(doc: &Document, stream: &Stream) -> Option<Vec<String>> {
    let Ok(raw) = stream.dict.get(b"Filter") else {
        return Some(Vec::new());
    };
    match deref(doc, raw) {
        Object::Name(_) => name_str(deref(doc, raw)).map(|name| vec![name]),
        Object::Array(items) => items
            .iter()
            .map(|item| name_str(deref(doc, item)))
            .collect(),
        _ => None,
    }
}

fn stream_decode_params(
    doc: &Document,
    stream: &Stream,
    filter_count: usize,
) -> Option<Vec<Option<PredictorParams>>> {
    let Ok(raw) = stream.dict.get(b"DecodeParms") else {
        return Some(vec![None; filter_count]);
    };
    match deref(doc, raw) {
        Object::Null => Some(vec![None; filter_count]),
        Object::Dictionary(_) if filter_count == 1 => Some(vec![Some(predictor_params(doc, raw)?)]),
        Object::Array(items) if items.len() == filter_count => items
            .iter()
            .map(|item| match deref(doc, item) {
                Object::Null => Some(None),
                Object::Dictionary(_) => predictor_params(doc, item).map(Some),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

fn strict_flate_decode(input: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = flate2::Decompress::new(true);
    let mut output = Vec::new();
    let mut input_offset = 0usize;
    let mut block = [0u8; 64 * 1024];
    loop {
        let input_before = decoder.total_in();
        let output_before = decoder.total_out();
        let status = decoder
            .decompress(
                &input[input_offset..],
                &mut block,
                flate2::FlushDecompress::Finish,
            )
            .ok()?;
        let consumed = (decoder.total_in() - input_before) as usize;
        let produced = (decoder.total_out() - output_before) as usize;
        input_offset = input_offset.saturating_add(consumed).min(input.len());
        output.extend_from_slice(&block[..produced]);
        match status {
            flate2::Status::StreamEnd if input_offset == input.len() => return Some(output),
            flate2::Status::StreamEnd => return None,
            flate2::Status::Ok | flate2::Status::BufError if consumed > 0 || produced > 0 => {}
            _ => return None,
        }
    }
}

fn strict_lzw_decode(input: &[u8], early_change: bool) -> Option<Vec<u8>> {
    use weezl::LzwStatus;

    // PDF bắt buộc code đầu là Clear-table 256, mã hoá MSB-first ở width 9.
    let first_code = (u16::from(*input.first()?) << 1) | (u16::from(*input.get(1)?) >> 7);
    if first_code != 256 {
        return None;
    }

    // PDF LZW khởi tạo bảng 256 literal (clear=256, EOD=257), tức min-size 8.
    // EarlyChange=1 dùng quy tắc đổi code-width sớm kiểu TIFF của weezl.
    let mut decoder = if early_change {
        weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
    } else {
        weezl::decode::Decoder::new(weezl::BitOrder::Msb, 8)
    };
    let mut output = Vec::new();
    let mut offset = 0usize;
    let mut block = [0u8; 64 * 1024];
    // weezl có thể read-ahead tối đa 8 byte. Decode bulk phần đầu, rồi chỉ cấp
    // từng byte ở tail ngắn để chứng minh EOD nằm trong byte cuối mà không biến
    // stream nhiều MiB thành hàng triệu lời gọi decoder.
    let bulk_end = input.len().saturating_sub(8);
    loop {
        let input_end = if offset < bulk_end {
            bulk_end
        } else {
            offset.checked_add(1)?.min(input.len())
        };
        if input_end <= offset {
            return None;
        }
        let result = decoder.decode_bytes(&input[offset..input_end], &mut block);
        offset = offset.saturating_add(result.consumed_in).min(input.len());
        output.extend_from_slice(&block[..result.consumed_out]);
        match result.status {
            Ok(LzwStatus::Done) if offset == input.len() => return Some(output),
            Ok(LzwStatus::Done) => return None,
            Ok(LzwStatus::Ok | LzwStatus::NoProgress)
                if result.consumed_in > 0 || result.consumed_out > 0 => {}
            _ => return None,
        }
    }
}

fn append_ascii85_group(output: &mut Vec<u8>, tuple: &[u8; 5], encoded_count: usize) -> Option<()> {
    let mut value = 0u64;
    for digit in tuple {
        value = value.checked_mul(85)?.checked_add(u64::from(*digit))?;
    }
    if value > u64::from(u32::MAX) {
        return None;
    }
    let bytes = (value as u32).to_be_bytes();
    output.extend_from_slice(&bytes[..encoded_count.checked_sub(1)?]);
    Some(())
}

fn strict_ascii85_decode(input: &[u8]) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len().saturating_mul(4) / 5);
    let mut tuple = [0u8; 5];
    let mut count = 0usize;
    let mut index = if input.starts_with(b"<~") { 2 } else { 0 };

    loop {
        let byte = *input.get(index)?;
        index += 1;
        match byte {
            b'~' => {
                if input.get(index) != Some(&b'>')
                    || !input[index.checked_add(1)?..]
                        .iter()
                        .all(|tail| tail.is_ascii_whitespace())
                    || count == 1
                {
                    return None;
                }
                if count > 1 {
                    for slot in tuple.iter_mut().skip(count) {
                        *slot = 84;
                    }
                    append_ascii85_group(&mut output, &tuple, count)?;
                }
                return Some(output);
            }
            b'z' if count == 0 => output.extend_from_slice(&[0, 0, 0, 0]),
            b'!'..=b'u' => {
                tuple[count] = byte - b'!';
                count += 1;
                if count == 5 {
                    append_ascii85_group(&mut output, &tuple, count)?;
                    count = 0;
                }
            }
            whitespace if whitespace.is_ascii_whitespace() => {}
            _ => return None,
        }
    }
}

fn strict_asciihex_decode(input: &[u8]) -> Option<Vec<u8>> {
    let marker = input.iter().position(|byte| *byte == b'>')?;
    if !input[marker.checked_add(1)?..]
        .iter()
        .all(|byte| byte.is_ascii_whitespace())
    {
        return None;
    }
    asciihex_decode(input).ok()
}

fn strict_runlength_decode(input: &[u8]) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let mut index = 0usize;
    while index < input.len() {
        let length = input[index];
        index += 1;
        match length {
            128 if index == input.len() => return Some(output),
            128 => return None,
            0..=127 => {
                let count = length as usize + 1;
                let end = index.checked_add(count)?;
                if end > input.len() {
                    return None;
                }
                output.extend_from_slice(&input[index..end]);
                index = end;
            }
            _ => {
                let value = *input.get(index)?;
                index += 1;
                output.extend(std::iter::repeat_n(value, 257 - length as usize));
            }
        }
    }
    None
}

fn strict_apply_predictor(data: &[u8], params: PredictorParams) -> Option<Vec<u8>> {
    if params.predictor == 1 {
        return Some(data.to_vec());
    }
    let row_bits = params
        .columns
        .checked_mul(params.colors)?
        .checked_mul(params.bits_per_component)?;
    let row_len = row_bits.checked_add(7)?.checked_div(8)?;
    if row_len == 0 {
        return None;
    }

    match params.predictor {
        2 => {
            if params.bits_per_component != 8 || data.len() % row_len != 0 {
                return None;
            }
        }
        10..=15 => {
            let stride = row_len.checked_add(1)?;
            if data.len() % stride != 0 {
                return None;
            }
            for row in data.chunks_exact(stride) {
                let filter = row[0];
                if filter > 4 || (params.predictor != 15 && filter != params.predictor - 10) {
                    return None;
                }
            }
        }
        _ => return None,
    }
    apply_predictor(data, params).ok()
}

fn exact_stream_bytes(doc: &Document, stream: &Stream) -> Option<Vec<u8>> {
    let filters = stream_filters(doc, stream)?;
    if filters.is_empty() {
        return Some(stream.content.clone());
    }
    let params = stream_decode_params(doc, stream, filters.len())?;
    let mut bytes = stream.content.clone();
    for (index, filter) in filters.iter().enumerate() {
        let param = params.get(index).copied().flatten();
        bytes = match filter.as_str() {
            "FlateDecode" | "Fl" => strict_flate_decode(&bytes)?,
            "LZWDecode" | "LZW" => {
                strict_lzw_decode(&bytes, param.unwrap_or_default().early_change)?
            }
            "ASCII85Decode" | "A85" => strict_ascii85_decode(&bytes)?,
            "ASCIIHexDecode" | "AHx" => strict_asciihex_decode(&bytes)?,
            "RunLengthDecode" | "RL" => strict_runlength_decode(&bytes)?,
            // Content stream không được chứa codec ảnh; Crypt khác Identity cần
            // ngữ cảnh mã hoá của document nên không thể chứng minh exact ở đây.
            _ => return None,
        };
        if let Some(param) = param {
            if param.predictor > 1 {
                if !matches!(filter.as_str(), "FlateDecode" | "Fl" | "LZWDecode" | "LZW") {
                    return None;
                }
                bytes = strict_apply_predictor(&bytes, param)?;
            }
        }
    }
    Some(bytes)
}

/// Giải mã một stream và giữ provenance của đường recovery.
///
/// CORRECTNESS (audit 2026-09-01 §PPE-E2): metadata `/Filter` và
/// `/DecodeParms` được deref qua document, rồi từng stage được giải nghiêm ngặt.
/// lopdf 0.44 có thể trả `Ok` với raw/partial bytes; đường đó chỉ dùng để cứu dữ
/// liệu và luôn mang `Recovered`, không bao giờ được nâng thành `Exact`.
pub fn decode_stream(doc: &Document, stream: &Stream) -> DecodedStream {
    if let Some(bytes) = exact_stream_bytes(doc, stream) {
        return DecodedStream {
            bytes,
            quality: DecodeQuality::Exact,
        };
    }

    let recovered = stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone());
    let bytes = if recovered.is_empty() && !stream.content.is_empty() {
        stream.content.clone()
    } else {
        recovered
    };
    DecodedStream {
        bytes,
        quality: DecodeQuality::Recovered,
    }
}

/// Nội dung stream cùng provenance sau khi giải tham chiếu.
pub fn stream_data_with_quality(doc: &Document, obj: &Object) -> Option<DecodedStream> {
    match deref(doc, obj) {
        Object::Stream(stream) => Some(decode_stream(doc, stream)),
        _ => None,
    }
}

/// Nội dung stream đã giải nén (FlateDecode/LZW/…).
///
/// API tương thích cho các consumer chưa cần provenance. Code render object nhìn
/// thấy được phải dùng [`stream_data_with_quality`] hoặc [`decode_stream`].
pub fn stream_data(doc: &Document, obj: &Object) -> Option<Vec<u8>> {
    stream_data_with_quality(doc, obj).map(|decoded| decoded.bytes)
}

/// `ObjectId` nếu object là tham chiếu gián tiếp — dùng làm khoá cache.
pub fn ref_id(obj: &Object) -> Option<ObjectId> {
    match obj {
        Object::Reference(id) => Some(*id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_hash_escapes_in_names() {
        assert_eq!(decode_pdf_name(b"PANTONE#20485#20C"), "PANTONE 485 C");
    }

    #[test]
    fn decodes_hash_escape_of_hash_itself() {
        assert_eq!(decode_pdf_name(b"a#23b"), "a#b");
    }

    #[test]
    fn leaves_plain_names_untouched() {
        assert_eq!(decode_pdf_name(b"CutContour"), "CutContour");
    }

    #[test]
    fn tolerates_truncated_escape() {
        assert_eq!(decode_pdf_name(b"bad#4"), "bad#4");
    }

    #[test]
    fn reads_both_integer_and_real() {
        assert_eq!(as_num(&Object::Integer(3)), Some(3.0));
        assert_eq!(as_num(&Object::Real(2.5)), Some(2.5));
        assert_eq!(as_num(&Object::Null), None);
    }

    #[test]
    fn broken_reference_resolves_to_null_not_panic() {
        let doc = Document::new();
        let obj = Object::Reference((999, 0));
        assert!(matches!(deref(&doc, &obj), Object::Null));
    }
}
