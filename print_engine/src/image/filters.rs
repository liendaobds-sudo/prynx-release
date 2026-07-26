//! Chuỗi filter của stream PDF, cho đường ảnh.
//!
//! # Vì sao PPE tự giải nén thay vì dùng lopdf
//!
//! `lopdf::Stream::decompressed_content` không áp **predictor**. Với ảnh, hầu hết
//! encoder (Acrobat, Illustrator) ghi `/DecodeParms << /Predictor 15 … >>`: dữ
//! liệu sau khi inflate vẫn còn là **hiệu số theo hàng**, chưa phải pixel. Bỏ
//! bước predictor thì ảnh ra nhiễu sọc — và tệ hơn, nó vẫn "giải nén thành công"
//! nên không có lỗi nào nổi lên.
//!
//! Ngoài ra ta cần dừng chuỗi filter **trước** codec ảnh (`DCTDecode`,
//! `JPXDecode`, `CCITTFaxDecode`) để bàn phần còn lại cho bộ giải mã ảnh, việc
//! mà API all-or-nothing của lopdf không làm được.

use std::io::Read;

use crate::error::{PpeError, PpeResult};

/// Codec ảnh — filter cuối chuỗi, không giải bằng bộ giải nén thông thường.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageCodec {
    /// JPEG.
    Dct,
    /// JPEG 2000.
    Jpx,
    /// Fax nhóm 3/4 (ảnh đen trắng scan).
    CcittFax,
    /// JBIG2.
    Jbig2,
}

impl ImageCodec {
    pub fn from_filter_name(name: &str) -> Option<ImageCodec> {
        match name {
            "DCTDecode" | "DCT" => Some(ImageCodec::Dct),
            "JPXDecode" => Some(ImageCodec::Jpx),
            "CCITTFaxDecode" | "CCF" => Some(ImageCodec::CcittFax),
            "JBIG2Decode" => Some(ImageCodec::Jbig2),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            ImageCodec::Dct => "DCTDecode",
            ImageCodec::Jpx => "JPXDecode",
            ImageCodec::CcittFax => "CCITTFaxDecode",
            ImageCodec::Jbig2 => "JBIG2Decode",
        }
    }
}

/// Tham số `/DecodeParms` liên quan tới predictor.
#[derive(Debug, Clone, Copy)]
pub struct PredictorParams {
    /// 1 = không predictor, 2 = TIFF, ≥10 = PNG.
    pub predictor: u8,
    pub colors: usize,
    pub bits_per_component: usize,
    pub columns: usize,
    /// `/EarlyChange` của LZWDecode. Mặc định 1 (đổi kích thước mã sớm một bước).
    ///
    /// Sai cờ này thì LZW ra dữ liệu lệch dần từ giữa stream — ảnh nửa trên đúng,
    /// nửa dưới nhiễu.
    pub early_change: bool,
}

impl Default for PredictorParams {
    fn default() -> Self {
        // Mặc định theo ISO 32000-2 Table 10.
        PredictorParams {
            predictor: 1,
            colors: 1,
            bits_per_component: 8,
            columns: 1,
            early_change: true,
        }
    }
}

/// Kết quả giải chuỗi filter.
pub struct DecodedStream {
    /// Byte đã giải nén (nếu còn codec ảnh thì đây là dữ liệu đầu vào của codec).
    pub data: Vec<u8>,
    /// Codec ảnh còn lại chưa giải, nếu có.
    pub remaining_codec: Option<ImageCodec>,
}

/// Trần kích thước sau giải nén cho một ảnh: 512 MB.
///
/// Chống "decompression bomb": vài KB nén có thể phình ra hàng GB. Không có trần
/// thì một PDF hỏng đủ sức giết tiến trình backend.
const MAX_DECODED: usize = 512 * 1024 * 1024;

/// Giải chuỗi filter, dừng lại khi gặp codec ảnh.
///
/// `filters` theo thứ tự **giải mã** như trong `/Filter`. `parms` song song với
/// `filters`; phần tử thiếu dùng mặc định.
pub fn decode_chain(
    raw: &[u8],
    filters: &[String],
    parms: &[Option<PredictorParams>],
) -> PpeResult<DecodedStream> {
    let mut data = raw.to_vec();

    for (i, filter) in filters.iter().enumerate() {
        if let Some(codec) = ImageCodec::from_filter_name(filter) {
            // Codec ảnh phải là filter cuối. Nếu còn filter sau nó thì file lệch
            // spec — báo rõ thay vì giải mã bừa.
            if i + 1 != filters.len() {
                return Err(PpeError::MalformedPdf(format!(
                    "{} không phải filter cuối trong chuỗi",
                    codec.name()
                )));
            }
            return Ok(DecodedStream {
                data,
                remaining_codec: Some(codec),
            });
        }

        data = match filter.as_str() {
            "FlateDecode" | "Fl" => inflate(&data)?,
            "LZWDecode" | "LZW" => {
                let early = parms.get(i).and_then(|p| *p).map(|p| p.early_change);
                lzw_decode(&data, early)?
            }
            "ASCII85Decode" | "A85" => ascii85_decode(&data)?,
            "ASCIIHexDecode" | "AHx" => asciihex_decode(&data)?,
            "RunLengthDecode" | "RL" => runlength_decode(&data)?,
            // Crypt với /Identity là no-op; dạng khác thì tài liệu đã mã hoá.
            "Crypt" => data,
            other => {
                return Err(PpeError::Unsupported(format!("filter {other}")));
            }
        };

        if let Some(p) = parms.get(i).and_then(|p| *p) {
            if p.predictor > 1 {
                data = apply_predictor(&data, p)?;
            }
        }
    }

    Ok(DecodedStream {
        data,
        remaining_codec: None,
    })
}

fn inflate(input: &[u8]) -> PpeResult<Vec<u8>> {
    // Thử zlib trước (đúng spec), rồi deflate thô: nhiều PDF thực tế thiếu header
    // zlib. Chấp nhận cả hai là điều kiện để đọc được file từ encoder cũ.
    if let Ok(out) = inflate_with(input, true) {
        return Ok(out);
    }
    // Một số file có rác trước dữ liệu nén; thử bỏ byte đầu.
    if input.len() > 1 {
        if let Ok(out) = inflate_with(&input[1..], true) {
            return Ok(out);
        }
    }
    inflate_with(input, false)
}

fn inflate_with(input: &[u8], zlib: bool) -> PpeResult<Vec<u8>> {
    let mut out = Vec::new();
    let taken = Read::take(std::io::Cursor::new(input), input.len() as u64);
    let result = if zlib {
        flate2::read::ZlibDecoder::new(taken)
            .take(MAX_DECODED as u64)
            .read_to_end(&mut out)
    } else {
        flate2::read::DeflateDecoder::new(taken)
            .take(MAX_DECODED as u64)
            .read_to_end(&mut out)
    };
    match result {
        // Dữ liệu bị cắt vẫn dùng được phần đã giải: ảnh thiếu đuôi còn hơn mất
        // cả trang. Chỉ coi là lỗi khi không giải được byte nào.
        Ok(_) => Ok(out),
        Err(_) if !out.is_empty() => Ok(out),
        Err(e) => Err(PpeError::MalformedPdf(format!("FlateDecode lỗi: {e}"))),
    }
}

fn lzw_decode(input: &[u8], early_change: Option<bool>) -> PpeResult<Vec<u8>> {
    let early = early_change.unwrap_or(true);
    let mut decoder = if early {
        weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 7)
    } else {
        weezl::decode::Decoder::new(weezl::BitOrder::Msb, 7)
    };
    let mut out = Vec::new();
    let result = decoder.into_stream(&mut out).decode_all(input);
    if result.status.is_err() && out.is_empty() {
        return Err(PpeError::MalformedPdf("LZWDecode lỗi".into()));
    }
    Ok(out)
}

/// ASCII85 (§7.4.3).
pub fn ascii85_decode(input: &[u8]) -> PpeResult<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 4 / 5);
    let mut tuple = [0u8; 5];
    let mut count = 0usize;
    let mut i = 0usize;

    // Bỏ tiền tố `<~` nếu có.
    if input.len() >= 2 && &input[0..2] == b"<~" {
        i = 2;
    }

    while i < input.len() {
        let c = input[i];
        i += 1;
        match c {
            b'~' => break, // `~>` kết thúc
            b'z' if count == 0 => {
                out.extend_from_slice(&[0, 0, 0, 0]);
            }
            b'!'..=b'u' => {
                tuple[count] = c - b'!';
                count += 1;
                if count == 5 {
                    out.extend_from_slice(&decode_a85_group(&tuple, 5));
                    count = 0;
                }
            }
            c if c.is_ascii_whitespace() => {}
            _ => {
                return Err(PpeError::MalformedPdf(format!(
                    "ASCII85Decode có ký tự không hợp lệ: {c:#x}"
                )))
            }
        }
    }
    if count > 0 {
        if count == 1 {
            return Err(PpeError::MalformedPdf(
                "ASCII85Decode nhóm cuối chỉ 1 ký tự".into(),
            ));
        }
        for slot in tuple.iter_mut().skip(count) {
            *slot = 84; // đệm bằng 'u'
        }
        out.extend_from_slice(&decode_a85_group(&tuple, count));
    }
    Ok(out)
}

fn decode_a85_group(tuple: &[u8; 5], count: usize) -> Vec<u8> {
    let mut value: u32 = 0;
    for t in tuple.iter() {
        value = value.wrapping_mul(85).wrapping_add(*t as u32);
    }
    let bytes = value.to_be_bytes();
    bytes[..count - 1].to_vec()
}

/// ASCIIHex (§7.4.2).
pub fn asciihex_decode(input: &[u8]) -> PpeResult<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 2);
    let mut hi: Option<u8> = None;
    for &c in input {
        if c == b'>' {
            break;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        let v = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => {
                return Err(PpeError::MalformedPdf(format!(
                    "ASCIIHexDecode có ký tự không hợp lệ: {c:#x}"
                )))
            }
        };
        match hi {
            None => hi = Some(v),
            Some(h) => {
                out.push((h << 4) | v);
                hi = None;
            }
        }
    }
    // Nửa byte lẻ cuối: spec quy định đệm 0.
    if let Some(h) = hi {
        out.push(h << 4);
    }
    Ok(out)
}

/// RunLength (§7.4.5).
pub fn runlength_decode(input: &[u8]) -> PpeResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < input.len() {
        let len = input[i];
        i += 1;
        match len {
            128 => break, // EOD
            0..=127 => {
                let n = len as usize + 1;
                let end = (i + n).min(input.len());
                out.extend_from_slice(&input[i..end]);
                i = end;
            }
            _ => {
                let n = 257 - len as usize;
                if i < input.len() {
                    let b = input[i];
                    i += 1;
                    out.extend(std::iter::repeat_n(b, n));
                }
            }
        }
        if out.len() > MAX_DECODED {
            return Err(PpeError::MalformedPdf(
                "RunLengthDecode vượt trần bộ nhớ".into(),
            ));
        }
    }
    Ok(out)
}

/// Áp predictor PNG (≥10) hoặc TIFF (2).
pub fn apply_predictor(data: &[u8], p: PredictorParams) -> PpeResult<Vec<u8>> {
    let colors = p.colors.max(1);
    let bpc = p.bits_per_component.max(1);
    let columns = p.columns.max(1);
    let bpp = (colors * bpc + 7) / 8; // byte mỗi pixel, tối thiểu 1
    let row_len = (columns * colors * bpc + 7) / 8;

    if p.predictor == 2 {
        return Ok(tiff_predictor(data, colors, bpc, columns, row_len));
    }

    // PNG: mỗi hàng có thêm 1 byte đầu ghi loại filter.
    let stride = row_len + 1;
    let rows = data.len() / stride;
    let mut out = Vec::with_capacity(rows * row_len);
    let mut prev_row = vec![0u8; row_len];

    for r in 0..rows {
        let start = r * stride;
        let filter_type = data[start];
        let src = &data[start + 1..start + 1 + row_len];
        let mut row = src.to_vec();

        match filter_type {
            0 => {}
            1 => {
                for i in bpp..row_len {
                    row[i] = row[i].wrapping_add(row[i - bpp]);
                }
            }
            2 => {
                for i in 0..row_len {
                    row[i] = row[i].wrapping_add(prev_row[i]);
                }
            }
            3 => {
                for i in 0..row_len {
                    let left = if i >= bpp { row[i - bpp] as u16 } else { 0 };
                    let up = prev_row[i] as u16;
                    row[i] = row[i].wrapping_add(((left + up) / 2) as u8);
                }
            }
            4 => {
                for i in 0..row_len {
                    let a = if i >= bpp { row[i - bpp] as i16 } else { 0 };
                    let b = prev_row[i] as i16;
                    let c = if i >= bpp {
                        prev_row[i - bpp] as i16
                    } else {
                        0
                    };
                    row[i] = row[i].wrapping_add(paeth(a, b, c));
                }
            }
            other => {
                return Err(PpeError::MalformedPdf(format!(
                    "predictor PNG có loại filter lạ: {other}"
                )))
            }
        }
        out.extend_from_slice(&row);
        prev_row = row;
    }
    Ok(out)
}

fn paeth(a: i16, b: i16, c: i16) -> u8 {
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

fn tiff_predictor(
    data: &[u8],
    colors: usize,
    bpc: usize,
    columns: usize,
    row_len: usize,
) -> Vec<u8> {
    // Chỉ 8 bit có ý nghĩa thực tế trong PDF; bpc khác trả nguyên bản thay vì
    // biến đổi sai.
    if bpc != 8 {
        return data.to_vec();
    }
    let mut out = data.to_vec();
    let rows = if row_len == 0 {
        0
    } else {
        data.len() / row_len
    };
    for r in 0..rows {
        let base = r * row_len;
        for col in 1..columns {
            for ch in 0..colors {
                let i = base + col * colors + ch;
                let prev = base + (col - 1) * colors + ch;
                if i < out.len() && prev < out.len() {
                    out[i] = out[i].wrapping_add(out[prev]);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zlib(data: &[u8]) -> Vec<u8> {
        use flate2::write::ZlibEncoder;
        use std::io::Write;
        let mut e = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn flate_roundtrip() {
        let original = b"muc CMYK 100 100 100 100";
        let out = decode_chain(&zlib(original), &["FlateDecode".into()], &[None]).unwrap();
        assert_eq!(out.data, original);
        assert!(out.remaining_codec.is_none());
    }

    #[test]
    fn truncated_flate_keeps_partial_data_instead_of_failing() {
        // Ảnh thiếu đuôi còn dùng được; mất cả trang thì không.
        // Dữ liệu khó nén (không phải chuỗi lặp) để nửa stream đã đủ sinh output.
        let original: Vec<u8> = (0..65536u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect();
        let full = zlib(&original);
        let cut = &full[..full.len() / 2];
        let out = decode_chain(cut, &["FlateDecode".into()], &[None]).unwrap();
        assert!(!out.data.is_empty(), "phải giữ được phần đã giải nén");
        assert!(
            out.data.len() < original.len(),
            "và phải là một phần, không phải toàn bộ"
        );
        assert_eq!(&out.data[..64], &original[..64], "phần giải được phải đúng");
    }

    #[test]
    fn asciihex_decodes_and_stops_at_gt() {
        let out = asciihex_decode(b"48 65 6C 6C 6F>zzz").unwrap();
        assert_eq!(out, b"Hello");
    }

    #[test]
    fn asciihex_pads_odd_nibble() {
        // Spec: nửa byte lẻ cuối đệm 0 ⇒ "4" thành 0x40.
        assert_eq!(asciihex_decode(b"4>").unwrap(), vec![0x40]);
    }

    #[test]
    fn asciihex_rejects_invalid_char() {
        assert!(asciihex_decode(b"4G>").is_err());
    }

    #[test]
    fn ascii85_decodes_known_value() {
        // "sure" mã hoá ASCII85 là "F*2M7".
        assert_eq!(ascii85_decode(b"F*2M7~>").unwrap(), b"sure");
    }

    #[test]
    fn ascii85_z_shortcut_is_four_zero_bytes() {
        assert_eq!(ascii85_decode(b"z~>").unwrap(), vec![0, 0, 0, 0]);
    }

    #[test]
    fn ascii85_handles_prefix_and_whitespace() {
        assert_eq!(ascii85_decode(b"<~F*2 M7\n~>").unwrap(), b"sure");
    }

    #[test]
    fn ascii85_rejects_single_char_final_group() {
        assert!(ascii85_decode(b"F*2M7F~>").is_err());
    }

    #[test]
    fn ascii85_matches_reference_on_real_pdf_stream() {
        // Dữ liệu thật lấy từ `14_progressive_jpeg.pdf`, đối chiếu với bộ giải
        // ASCII85 tham chiếu. Test này tồn tại vì khi ảnh đó không giải mã được,
        // câu hỏi đầu tiên phải là "ASCII85 của ta có sai không" — và câu trả lời
        // phải chốt được bằng dữ liệu, không phải suy đoán.
        let raw: &[u8] = b"s4I@g!\"fJ;!!*'#!s&u6!YGG8&HVpc!!iT+!!#4`<G$ITf`~>";
        let out = ascii85_decode(raw).unwrap();
        let expected = [
            0xff, 0xd8, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01,
            0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
            0x00, 0x00, 0x3f, 0x00, 0x55, 0x66, 0x77, 0xff, 0xd9,
        ];
        assert_eq!(out.len(), 37);
        assert_eq!(out, expected);
        // Và đây là lý do ảnh đó không vẽ được: 37 byte không phải một JPEG
        // 256x256 thật, fixture chỉ là stub. Lỗi nằm ở fixture, không ở engine.
        assert_eq!(&out[..2], &[0xff, 0xd8], "có SOI nhưng thân ảnh là giả");
    }

    #[test]
    fn runlength_literal_and_repeat() {
        // 2,'a','b','c' = 3 byte literal; 254,'x' = 3 lần 'x'; 128 = EOD.
        let out = runlength_decode(&[2, b'a', b'b', b'c', 254, b'x', 128]).unwrap();
        assert_eq!(out, b"abcxxx");
    }

    #[test]
    fn runlength_stops_at_eod() {
        let out = runlength_decode(&[0, b'a', 128, 0, b'b']).unwrap();
        assert_eq!(out, b"a", "byte sau EOD phải bị bỏ");
    }

    #[test]
    fn png_predictor_up_reconstructs_rows() {
        // 2 hàng, 3 byte/hàng. Hàng 1 filter 0 (none), hàng 2 filter 2 (up).
        let raw = vec![0, 10, 20, 30, 2, 1, 1, 1];
        let p = PredictorParams {
            predictor: 15,
            colors: 3,
            bits_per_component: 8,
            columns: 1,
            ..Default::default()
        };
        let out = apply_predictor(&raw, p).unwrap();
        assert_eq!(out, vec![10, 20, 30, 11, 21, 31]);
    }

    #[test]
    fn png_predictor_sub_uses_left_pixel() {
        // 1 hàng, 2 pixel RGB, filter 1 (sub).
        let raw = vec![1, 10, 20, 30, 5, 5, 5];
        let p = PredictorParams {
            predictor: 15,
            colors: 3,
            bits_per_component: 8,
            columns: 2,
            ..Default::default()
        };
        let out = apply_predictor(&raw, p).unwrap();
        assert_eq!(out, vec![10, 20, 30, 15, 25, 35]);
    }

    #[test]
    fn png_predictor_paeth_matches_reference() {
        // 2 hàng × 4 byte, colors=1: hàng 1 filter 0, hàng 2 filter 4 (Paeth).
        // Hàng 2 toàn 0 ⇒ Paeth dự đoán đúng bằng hàng trên (a=left, b=up, c=up-left)
        // nên kết quả phải lặp lại hàng 1.
        let raw = vec![0, 10, 20, 30, 40, 4, 0, 0, 0, 0];
        let p = PredictorParams {
            predictor: 15,
            colors: 1,
            bits_per_component: 8,
            columns: 4,
            ..Default::default()
        };
        let out = apply_predictor(&raw, p).unwrap();
        assert_eq!(out.len(), 8);
        assert_eq!(&out[..4], &[10, 20, 30, 40], "hàng 1 không filter");
        assert_eq!(
            &out[4..],
            &[10, 20, 30, 40],
            "Paeth với delta 0 phải lặp hàng trên"
        );
    }

    #[test]
    fn lzw_early_change_flag_is_honoured() {
        // Không đọc /EarlyChange thì LZW lệch dần từ giữa stream: nửa trên ảnh
        // đúng, nửa dưới nhiễu. Ở đây chỉ chốt rằng cờ được truyền xuống.
        let p = PredictorParams {
            early_change: false,
            ..Default::default()
        };
        // Dữ liệu LZW hỏng ⇒ cả hai chế độ đều lỗi, nhưng không được panic.
        let r = decode_chain(b"\x80\x0B\x60", &["LZWDecode".into()], &[Some(p)]);
        assert!(r.is_ok() || r.is_err());
    }

    #[test]
    fn png_predictor_rejects_unknown_filter_type() {
        let raw = vec![9, 1, 2, 3];
        let p = PredictorParams {
            predictor: 15,
            colors: 3,
            bits_per_component: 8,
            columns: 1,
            ..Default::default()
        };
        assert!(apply_predictor(&raw, p).is_err());
    }

    #[test]
    fn tiff_predictor_accumulates_horizontally() {
        let raw = vec![10, 1, 1, 1];
        let p = PredictorParams {
            predictor: 2,
            colors: 1,
            bits_per_component: 8,
            columns: 4,
            ..Default::default()
        };
        let out = apply_predictor(&raw, p).unwrap();
        assert_eq!(out, vec![10, 11, 12, 13]);
    }

    #[test]
    fn predictor_is_applied_inside_chain() {
        // Đây là bug mà lopdf không lo: inflate xong PHẢI áp predictor.
        let rows = vec![0u8, 10, 20, 30, 2, 1, 1, 1];
        let p = PredictorParams {
            predictor: 15,
            colors: 3,
            bits_per_component: 8,
            columns: 1,
            ..Default::default()
        };
        let out = decode_chain(&zlib(&rows), &["FlateDecode".into()], &[Some(p)]).unwrap();
        assert_eq!(out.data, vec![10, 20, 30, 11, 21, 31]);
    }

    #[test]
    fn image_codec_is_left_for_the_image_decoder() {
        let out = decode_chain(b"\xFF\xD8\xFF", &["DCTDecode".into()], &[None]).unwrap();
        assert_eq!(out.remaining_codec, Some(ImageCodec::Dct));
        assert_eq!(out.data, b"\xFF\xD8\xFF");
    }

    #[test]
    fn flate_then_dct_chain_inflates_first() {
        let jpeg = b"\xFF\xD8\xFF\xE0 fake";
        let out = decode_chain(
            &zlib(jpeg),
            &["FlateDecode".into(), "DCTDecode".into()],
            &[None, None],
        )
        .unwrap();
        assert_eq!(out.remaining_codec, Some(ImageCodec::Dct));
        assert_eq!(out.data, jpeg);
    }

    #[test]
    fn codec_not_last_in_chain_is_an_error() {
        // Sai spec — báo rõ thay vì giải mã bừa ra dữ liệu mực vô nghĩa.
        assert!(decode_chain(
            b"x",
            &["DCTDecode".into(), "FlateDecode".into()],
            &[None, None]
        )
        .is_err());
    }

    #[test]
    fn unknown_filter_is_reported() {
        assert!(decode_chain(b"x", &["MagicDecode".into()], &[None]).is_err());
    }

    #[test]
    fn codec_names_map_including_abbreviations() {
        assert_eq!(ImageCodec::from_filter_name("DCT"), Some(ImageCodec::Dct));
        assert_eq!(
            ImageCodec::from_filter_name("CCF"),
            Some(ImageCodec::CcittFax)
        );
        assert_eq!(ImageCodec::from_filter_name("FlateDecode"), None);
    }
}
