//! Tiện ích đọc object PDF.
//!
//! Gom mọi phép giải tham chiếu (`Reference`) và đọc số/tên vào một chỗ. Lý do:
//! trong PDF gần như **mọi** giá trị đều có thể là tham chiếu gián tiếp, kể cả
//! một con số trong mảng. Rải `dereference` khắp interpreter là nguồn bug im
//! lặng (đọc ra 0 rồi vẽ sai) khó truy nhất.

use lopdf::{Dictionary, Document, Object, ObjectId};

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

/// Nội dung stream đã giải nén (FlateDecode/LZW/…).
pub fn stream_data(doc: &Document, obj: &Object) -> Option<Vec<u8>> {
    match deref(doc, obj) {
        Object::Stream(s) => s
            .decompressed_content()
            .ok()
            .or_else(|| Some(s.content.clone())),
        _ => None,
    }
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
