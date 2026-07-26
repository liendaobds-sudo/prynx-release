//! Giải mã ảnh XObject thành bộ lấy mẫu trong không gian mực.
//!
//! # Nguyên tắc: giải nén sớm, quy màu muộn
//!
//! Ảnh được giải về **mẫu thành phần** (component sample) rồi giữ nguyên ở đó.
//! Việc quy sang mực chỉ xảy ra khi một pixel thiết bị thực sự cần tới nó.
//!
//! Lý do: ảnh in thường 300–600 DPI còn khung render hay là 100–150 DPI, nên phần
//! lớn pixel ảnh **không bao giờ được lấy mẫu**. Quy màu toàn bộ ảnh trước sẽ tốn
//! gấp nhiều lần công cần thiết, và với `Separation`/`DeviceN` (tint transform là
//! chương trình PostScript) thì đó là khác biệt giữa vài chục ms và vài giây.
//!
//! Với colorspace một thành phần (Gray, Indexed, Separation) engine dựng LUT 256
//! ô nên chi phí quy màu về gần bằng không.

use lopdf::{Dictionary, Document, Object};

use crate::color::space::resolve_colorspace;
use crate::color::icc::ColorManager;
use crate::color::ColorSpace;
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::image::filters::{decode_chain, ImageCodec, PredictorParams};
use crate::ink::{ChannelMask, InkSpace};
use crate::pdf;

/// Trần số pixel một ảnh: 200 MP. Chống PDF khai `/Width 1e9`.
const MAX_IMAGE_PIXELS: u64 = 200_000_000;

/// Ảnh đã giải mã, sẵn sàng lấy mẫu.
pub struct SampledImage {
    pub width: u32,
    pub height: u32,
    /// Số thành phần màu mỗi pixel (1 với Indexed / Gray / Separation).
    pub n_comps: usize,
    /// Mẫu đã chuẩn hoá về u8, xếp interleaved `[p0c0, p0c1, …]`.
    ///
    /// Với `Indexed` đây là **chỉ số bảng màu**, không phải cường độ.
    samples: Vec<u8>,
    /// Colorspace của ảnh. `None` khi ảnh là stencil (`/ImageMask`).
    pub colorspace: Option<ColorSpace>,
    /// `/Decode` đã chuẩn hoá; rỗng nghĩa là mặc định.
    decode: Vec<f32>,
    /// Số bit mỗi thành phần trong file gốc.
    ///
    /// Cần cho `/Decode` của `Indexed`: khoảng chỉ số là 0..2^bpc−1, không phải
    /// 0..255. Dùng 255 cho ảnh 4 bit sẽ ánh xạ sai toàn bộ bảng màu.
    bpc: usize,
    /// Ảnh stencil `/ImageMask`: `true` tại pixel **được** tô.
    pub stencil: Option<Vec<bool>>,
    /// Alpha 0..1 từ `/SMask`, cùng kích thước ảnh gốc (đã lấy mẫu lại nếu lệch).
    pub alpha: Option<Vec<f32>>,
}

impl SampledImage {
    /// Giá trị thành phần đã áp `/Decode`, trong khoảng của colorspace.
    pub fn components_at(&self, x: u32, y: u32) -> Vec<f32> {
        let idx = (y as usize * self.width as usize + x as usize) * self.n_comps;
        let mut out = Vec::with_capacity(self.n_comps);
        let indexed = matches!(self.colorspace, Some(ColorSpace::Indexed { .. }));
        for c in 0..self.n_comps {
            let raw = self.samples.get(idx + c).copied().unwrap_or(0);
            out.push(self.decode_component(c, raw, indexed));
        }
        out
    }

    /// Mẫu DeviceRGB gốc sau `/Decode`, dùng để alpha/blend trước ICC.
    pub fn device_rgb_at(&self, x: u32, y: u32) -> Option<[f32; 3]> {
        if !matches!(self.colorspace, Some(ColorSpace::DeviceRGB)) {
            return None;
        }
        let comps = self.components_at(x, y);
        Some([
            comps.first().copied().unwrap_or(0.0).clamp(0.0, 1.0),
            comps.get(1).copied().unwrap_or(0.0).clamp(0.0, 1.0),
            comps.get(2).copied().unwrap_or(0.0).clamp(0.0, 1.0),
        ])
    }

    fn decode_component(&self, c: usize, raw: u8, indexed: bool) -> f32 {
        // Indexed: mẫu LÀ chỉ số, không chia 255.
        if indexed {
            let v = raw as f32;
            let index_max = ((1u32 << self.bpc.min(8)) - 1) as f32;
            return match (self.decode.first(), self.decode.get(1)) {
                (Some(d0), Some(d1)) => d0 + v * (d1 - d0) / index_max.max(1.0),
                _ => v,
            };
        }
        let unit = raw as f32 / 255.0;
        match (self.decode.get(2 * c), self.decode.get(2 * c + 1)) {
            (Some(d0), Some(d1)) => d0 + unit * (d1 - d0),
            _ => match &self.colorspace {
                // Lab có khoảng riêng, không phải 0..1.
                Some(ColorSpace::Lab) => {
                    if c == 0 {
                        unit * 100.0
                    } else {
                        unit * 255.0 - 128.0
                    }
                }
                _ => unit,
            },
        }
    }

    pub fn alpha_at(&self, x: u32, y: u32) -> f32 {
        match &self.alpha {
            Some(a) => a
                .get(y as usize * self.width as usize + x as usize)
                .copied()
                .unwrap_or(1.0),
            None => 1.0,
        }
    }

    /// `true` nếu stencil cho phép tô tại pixel này.
    pub fn stencil_at(&self, x: u32, y: u32) -> bool {
        match &self.stencil {
            Some(s) => s
                .get(y as usize * self.width as usize + x as usize)
                .copied()
                .unwrap_or(false),
            None => true,
        }
    }
}

/// Bộ lấy mẫu: quy thành phần → mực, có LUT cho colorspace một thành phần.
pub struct ImageSampler<'a> {
    image: &'a SampledImage,
    /// LUT 256 ô cho colorspace 1 thành phần: `[(ink, mask)]`.
    lut: Option<Vec<(Vec<f32>, ChannelMask)>>,
}

impl<'a> ImageSampler<'a> {
    /// Dựng bộ lấy mẫu. Có thể đăng ký spot mới vào [`InkSpace`] nên cần `&mut`.
    pub fn new(
        image: &'a SampledImage,
        space: &mut InkSpace,
        warn: &mut RenderWarnings,
        cm: Option<&ColorManager>,
    ) -> PpeResult<Self> {
        let mut lut = None;
        if image.n_comps == 1 {
            if let Some(cs) = &image.colorspace {
                let indexed = matches!(cs, ColorSpace::Indexed { .. });
                let mut table = Vec::with_capacity(256);
                for raw in 0u16..256 {
                    let comp = image.decode_component(0, raw as u8, indexed);
                    match cs.to_ink(&[comp], space, warn, cm)? {
                        Some((ink, mask)) => table.push((ink, mask)),
                        None => table.push((Vec::new(), ChannelMask::EMPTY)),
                    }
                }
                // Spot có thể được thêm giữa lúc dựng LUT ⇒ đồng bộ độ dài.
                let n = space.len();
                for entry in table.iter_mut() {
                    if !entry.0.is_empty() {
                        entry.0.resize(n, 0.0);
                    }
                }
                lut = Some(table);
            }
        }
        Ok(ImageSampler { image, lut })
    }

    /// Mực tại một pixel ảnh. `None` = không tô (colorant `/None`).
    pub fn ink_at(
        &self,
        x: u32,
        y: u32,
        space: &mut InkSpace,
        warn: &mut RenderWarnings,
        cm: Option<&ColorManager>,
    ) -> PpeResult<Option<(Vec<f32>, ChannelMask)>> {
        let mut out = Vec::new();
        match self.ink_into(x, y, &mut out, space, warn, cm)? {
            Some(mask) => Ok(Some((out, mask))),
            None => Ok(None),
        }
    }

    /// Như [`ImageSampler::ink_at`] nhưng ghi vào buffer có sẵn.
    ///
    /// Ảnh được lấy mẫu **mỗi pixel thiết bị một lần**; cấp phát một `Vec` cho
    /// từng pixel sẽ thống trị thời gian chạy. Bản này dùng lại buffer của caller
    /// nên vòng vẽ ảnh không cấp phát gì.
    pub fn ink_into(
        &self,
        x: u32,
        y: u32,
        out: &mut Vec<f32>,
        space: &mut InkSpace,
        warn: &mut RenderWarnings,
        cm: Option<&ColorManager>,
    ) -> PpeResult<Option<ChannelMask>> {
        if let Some(lut) = &self.lut {
            let idx = (y as usize * self.image.width as usize + x as usize) * self.image.n_comps;
            let raw = self.image.samples.get(idx).copied().unwrap_or(0) as usize;
            let (ink, mask) = &lut[raw];
            if ink.is_empty() {
                return Ok(None);
            }
            out.clear();
            out.extend_from_slice(ink);
            return Ok(Some(*mask));
        }
        let Some(cs) = &self.image.colorspace else {
            return Ok(None);
        };
        let comps = self.image.components_at(x, y);
        match cs.to_ink(&comps, space, warn, cm)? {
            Some((ink, mask)) => {
                out.clear();
                out.extend_from_slice(&ink);
                Ok(Some(mask))
            }
            None => Ok(None),
        }
    }
}

/// Giải mã một ảnh XObject.
pub fn decode_image(
    doc: &Document,
    stream_obj: &Object,
    resources: Option<&Dictionary>,
    warn: &mut RenderWarnings,
) -> PpeResult<SampledImage> {
    let stream = match pdf::deref(doc, stream_obj) {
        Object::Stream(s) => s,
        _ => return Err(PpeError::MalformedPdf("ảnh không phải stream".into())),
    };
    let dict = &stream.dict;

    let width = int_key(doc, dict, &["Width", "W"]).unwrap_or(0) as u32;
    let height = int_key(doc, dict, &["Height", "H"]).unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return Err(PpeError::MalformedPdf("ảnh thiếu Width/Height".into()));
    }
    if (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return Err(PpeError::MalformedPdf(format!(
            "ảnh {width}x{height} vượt trần {MAX_IMAGE_PIXELS} pixel"
        )));
    }

    let is_mask = bool_key(doc, dict, &["ImageMask", "IM"]).unwrap_or(false);
    let mut bpc = int_key(doc, dict, &["BitsPerComponent", "BPC"]).unwrap_or(8) as usize;
    if is_mask {
        // Stencil luôn 1 bit, bất kể file khai gì.
        bpc = 1;
    }

    let colorspace = if is_mask {
        None
    } else {
        let cs_obj = dict
            .get(b"ColorSpace")
            .or_else(|_| dict.get(b"CS"))
            .map_err(|_| PpeError::MalformedPdf("ảnh thiếu ColorSpace".into()))?
            .clone();
        Some(resolve_colorspace(doc, &cs_obj, resources, warn)?)
    };
    let n_comps = colorspace.as_ref().map(|cs| cs.n_components()).unwrap_or(1);

    let decode = pdf::dict_get(doc, dict, "Decode")
        .or_else(|| pdf::dict_get(doc, dict, "D"))
        .and_then(|o| pdf::num_array(doc, o))
        .unwrap_or_default();

    // ── Giải chuỗi filter ────────────────────────────────────────────────────
    let filters = filter_names(doc, dict);
    let parms = decode_parms(doc, dict, filters.len(), n_comps, bpc, width as usize);
    let decoded = decode_chain(&stream.content, &filters, &parms)?;

    // Indexed: mẫu là chỉ số bảng màu, tuyệt đối không trải thang.
    let is_indexed = matches!(colorspace, Some(ColorSpace::Indexed { .. }));

    let (samples, n_comps, bpc, colorspace) = match decoded.remaining_codec {
        None => (
            unpack_samples(&decoded.data, width, height, n_comps, bpc, !is_indexed),
            n_comps,
            bpc,
            colorspace,
        ),
        Some(ImageCodec::Dct) => {
            let (data, jpeg_comps) = decode_jpeg(&decoded.data)?;
            // JPEG tự khai số thành phần. Nếu lệch với /ColorSpace thì tin JPEG:
            // dữ liệu pixel là sự thật, dictionary có thể sai.
            let cs = if jpeg_comps == n_comps {
                colorspace
            } else {
                warn.note_approximated_colorspace(&format!(
                    "JPEG có {jpeg_comps} thành phần nhưng /ColorSpace khai {n_comps}"
                ));
                Some(match jpeg_comps {
                    1 => ColorSpace::DeviceGray,
                    4 => ColorSpace::DeviceCMYK,
                    _ => ColorSpace::DeviceRGB,
                })
            };
            (data, jpeg_comps, 8, cs)
        }
        Some(ImageCodec::CcittFax) => {
            // Fax nhóm 3/4 luôn là **một kênh một bit**, bất kể `/ColorSpace` khai gì.
            let params = ccitt_params(doc, dict, width, height);
            let packed = crate::image::ccitt::decode(&decoded.data, &params)?;
            (
                unpack_samples(&packed, width, height, 1, 1, !is_indexed),
                1,
                1,
                colorspace,
            )
        }
        Some(codec) => {
            return Err(PpeError::Unsupported(format!("codec ảnh {}", codec.name())));
        }
    };

    let stencil = if is_mask {
        // `/Decode [0 1]` (mặc định): mẫu 0 = TÔ. `/Decode [1 0]`: đảo lại.
        // Đảo ngược chỗ này là lỗi im lặng kinh điển — ảnh ra âm bản.
        let invert = decode.first().copied().unwrap_or(0.0) >= 0.5;
        Some(
            samples
                .iter()
                .map(|s| if invert { *s >= 128 } else { *s < 128 })
                .collect(),
        )
    } else {
        None
    };

    let alpha = decode_soft_mask(doc, dict, width, height, warn);

    Ok(SampledImage {
        width,
        height,
        n_comps,
        samples,
        colorspace,
        decode,
        bpc,
        stencil,
        alpha,
    })
}

/// `/SMask` — ảnh xám riêng làm alpha.
fn decode_soft_mask(
    doc: &Document,
    dict: &Dictionary,
    width: u32,
    height: u32,
    warn: &mut RenderWarnings,
) -> Option<Vec<f32>> {
    let smask_obj = dict.get(b"SMask").ok()?;
    let mask = match decode_image(doc, smask_obj, None, warn) {
        Ok(m) => m,
        Err(_) => {
            // Không đọc được mặt nạ: coi như đục nhưng PHẢI báo, vì vẽ đục chỗ
            // đáng ra trong suốt sẽ thêm mực không có thật.
            warn.unsupported_transparency = true;
            warn.note_skipped_op("SMask ảnh (không giải mã được)");
            return None;
        }
    };

    let mut out = vec![1.0f32; (width as usize) * (height as usize)];
    for y in 0..height {
        for x in 0..width {
            // Mặt nạ có thể khác kích thước ảnh — lấy mẫu gần nhất.
            let mx = if width > 1 {
                (x as u64 * (mask.width as u64 - 1).max(0) / (width as u64 - 1).max(1)) as u32
            } else {
                0
            };
            let my = if height > 1 {
                (y as u64 * (mask.height as u64 - 1).max(0) / (height as u64 - 1).max(1)) as u32
            } else {
                0
            };
            let v = mask
                .components_at(mx.min(mask.width - 1), my.min(mask.height - 1))
                .first()
                .copied()
                .unwrap_or(1.0);
            out[y as usize * width as usize + x as usize] = v.clamp(0.0, 1.0);
        }
    }
    Some(out)
}

/// Giải mã JPEG. Trả (mẫu interleaved u8, số thành phần).
fn decode_jpeg(data: &[u8]) -> PpeResult<(Vec<u8>, usize)> {
    use jpeg_decoder::{Decoder, PixelFormat};

    let mut decoder = Decoder::new(std::io::Cursor::new(data));
    let pixels = decoder
        .decode()
        .map_err(|e| PpeError::MalformedPdf(format!("DCTDecode lỗi: {e}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| PpeError::MalformedPdf("JPEG không có thông tin ảnh".into()))?;

    let n = match info.pixel_format {
        PixelFormat::L8 => 1,
        PixelFormat::L16 => 1,
        PixelFormat::RGB24 => 3,
        PixelFormat::CMYK32 => 4,
    };

    if info.pixel_format == PixelFormat::L16 {
        // Hạ 16→8 bit: đủ cho mọi mục đích đo mực (mực đo theo %).
        let out = pixels
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]).wrapping_shr(8) as u8)
            .collect();
        return Ok((out, 1));
    }

    if n == 4 {
        // JPEG CMYK do Adobe ghi bị **đảo** (APP14). Không đảo lại thì mọi vùng
        // đặc thành trắng và ngược lại — TAC sẽ sai hoàn toàn theo cả hai chiều.
        if has_adobe_marker(data) {
            let out = pixels.iter().map(|v| 255 - *v).collect();
            return Ok((out, 4));
        }
    }
    Ok((pixels, n))
}

/// Dò marker APP14 "Adobe" — dấu hiệu CMYK bị đảo.
fn has_adobe_marker(data: &[u8]) -> bool {
    let needle = b"Adobe";
    data.windows(needle.len()).take(4096).any(|w| w == needle)
}

/// Trải mẫu `bpc` bit về u8, cắt/đệm cho đủ `w*h*n`.
///
/// Mỗi **hàng** bắt đầu ở ranh giới byte (§8.9.5.1). Bỏ quy tắc này thì ảnh 1-bit
/// có chiều rộng không chia hết 8 sẽ bị xiên dần — lỗi rất dễ nhận ra bằng mắt
/// nhưng chỉ khi đã in ra.
/// `scale_to_full_range = false` giữ nguyên giá trị thô.
///
/// Bắt buộc dùng `false` cho `Indexed`: mẫu ở đó **là chỉ số bảng màu**, không
/// phải cường độ. Trải chỉ số ra thang 0..255 sẽ phá bảng màu — với ảnh 4 bit,
/// chỉ số 1 thành 17 và trỏ sai ô, chỉ có chỉ số 0 và chỉ số lớn nhất còn đúng.
/// Đây là lỗi chỉ hiện ra ở vài pixel nên MAE trung bình vẫn đẹp; chỉ đỉnh TAC
/// mới lộ.
fn unpack_samples(
    data: &[u8],
    w: u32,
    h: u32,
    n: usize,
    bpc: usize,
    scale_to_full_range: bool,
) -> Vec<u8> {
    let w = w as usize;
    let h = h as usize;
    let total = w * h * n;
    let mut out = vec![0u8; total];

    if bpc == 8 {
        let copy = total.min(data.len());
        out[..copy].copy_from_slice(&data[..copy]);
        return out;
    }
    if bpc == 16 {
        for i in 0..total {
            out[i] = data.get(i * 2).copied().unwrap_or(0);
        }
        return out;
    }

    let row_bits = w * n * bpc;
    let row_bytes = (row_bits + 7) / 8;
    let max = ((1u32 << bpc) - 1) as f32;
    for y in 0..h {
        let row_start_bit = y * row_bytes * 8;
        for i in 0..(w * n) {
            let bit = row_start_bit + i * bpc;
            let mut v: u32 = 0;
            for k in 0..bpc {
                let b = bit + k;
                let byte = data.get(b / 8).copied().unwrap_or(0);
                v = (v << 1) | ((byte >> (7 - (b % 8))) & 1) as u32;
            }
            out[y * w * n + i] = if scale_to_full_range {
                // Trải về thang 0..255 để mọi bpc dùng chung một đường lấy mẫu.
                (v as f32 / max * 255.0).round() as u8
            } else {
                v.min(255) as u8
            };
        }
    }
    out
}

/// Tham số `/DecodeParms` của `CCITTFaxDecode`.
///
/// `/DecodeParms` có thể là một dict hoặc một mảng song song với `/Filter`. Vì
/// `CCITTFaxDecode` bắt buộc là filter **cuối**, lấy dict cuối cùng có khoá của CCITT
/// là đủ và không phụ thuộc việc đếm đúng chỉ số filter.
fn ccitt_params(
    doc: &Document,
    dict: &Dictionary,
    width: u32,
    height: u32,
) -> crate::image::ccitt::CcittParams {
    use crate::image::ccitt::CcittParams;

    let obj = dict
        .get(b"DecodeParms")
        .or_else(|_| dict.get(b"DP"))
        .ok()
        .map(|o| pdf::deref(doc, o));

    let mut found: Option<&Dictionary> = None;
    match obj {
        Some(Object::Dictionary(d)) => found = Some(d),
        Some(Object::Array(items)) => {
            for item in items {
                if let Object::Dictionary(d) = pdf::deref(doc, item) {
                    if d.get(b"K").is_ok()
                        || d.get(b"Columns").is_ok()
                        || d.get(b"BlackIs1").is_ok()
                        || d.get(b"EncodedByteAlign").is_ok()
                        || d.get(b"Rows").is_ok()
                    {
                        found = Some(d);
                    }
                }
            }
        }
        _ => {}
    }

    let Some(d) = found else {
        // Không có `/DecodeParms`: theo spec `/Columns` mặc định 1728. Nhưng nếu ảnh
        // khai bề rộng khác thì tin `/Width` — dictionary của ảnh cụ thể hơn giá trị
        // mặc định lịch sử của fax, và dùng 1728 sẽ làm mọi hàng lệch.
        return CcittParams {
            columns: if width > 0 { width as usize } else { 1728 },
            rows: height as usize,
            ..Default::default()
        };
    };

    let k = pdf::dict_get(doc, d, "K").and_then(pdf::as_num).unwrap_or(0.0) as i32;
    let columns = pdf::dict_get(doc, d, "Columns")
        .and_then(pdf::as_num)
        .map(|v| v as usize)
        .unwrap_or(if width > 0 { width as usize } else { 1728 });
    let rows = pdf::dict_get(doc, d, "Rows")
        .and_then(pdf::as_num)
        .map(|v| v as usize)
        .filter(|v| *v > 0)
        .unwrap_or(height as usize);
    let black_is_1 = matches!(
        pdf::dict_get(doc, d, "BlackIs1"),
        Some(Object::Boolean(true))
    );
    let encoded_byte_align = matches!(
        pdf::dict_get(doc, d, "EncodedByteAlign"),
        Some(Object::Boolean(true))
    );

    CcittParams { k, columns, rows, black_is_1, encoded_byte_align }
}

fn filter_names(doc: &Document, dict: &Dictionary) -> Vec<String> {
    let obj = match dict.get(b"Filter").or_else(|_| dict.get(b"F")) {
        Ok(o) => pdf::deref(doc, o),
        Err(_) => return Vec::new(),
    };
    match obj {
        Object::Name(_) => pdf::name_str(obj).into_iter().collect(),
        Object::Array(items) => items
            .iter()
            .filter_map(|o| pdf::name_str(pdf::deref(doc, o)))
            .collect(),
        _ => Vec::new(),
    }
}

fn decode_parms(
    doc: &Document,
    dict: &Dictionary,
    n_filters: usize,
    colors: usize,
    bpc: usize,
    columns: usize,
) -> Vec<Option<PredictorParams>> {
    let obj = dict
        .get(b"DecodeParms")
        .or_else(|_| dict.get(b"DP"))
        .ok()
        .map(|o| pdf::deref(doc, o));

    let read = |d: &Dictionary| -> Option<PredictorParams> {
        // Không đòi `/Predictor` phải có: `/DecodeParms` cũng mang `/EarlyChange`
        // cho LZW. Trả None khi thiếu Predictor sẽ làm mất luôn cờ đó.
        let predictor = pdf::dict_get(doc, d, "Predictor")
            .and_then(pdf::as_num)
            .unwrap_or(1.0) as u8;
        Some(PredictorParams {
            predictor,
            colors: pdf::dict_get(doc, d, "Colors")
                .and_then(pdf::as_num)
                .map(|v| v as usize)
                .unwrap_or(colors),
            bits_per_component: pdf::dict_get(doc, d, "BitsPerComponent")
                .and_then(pdf::as_num)
                .map(|v| v as usize)
                .unwrap_or(bpc),
            columns: pdf::dict_get(doc, d, "Columns")
                .and_then(pdf::as_num)
                .map(|v| v as usize)
                .unwrap_or(columns),
            early_change: pdf::dict_get(doc, d, "EarlyChange")
                .and_then(pdf::as_num)
                .map(|v| v as i32 != 0)
                .unwrap_or(true),
        })
    };

    let mut out = vec![None; n_filters.max(1)];
    match obj {
        Some(Object::Dictionary(d)) => {
            if !out.is_empty() {
                out[0] = read(d);
            }
        }
        Some(Object::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                if i >= out.len() {
                    break;
                }
                if let Object::Dictionary(d) = pdf::deref(doc, item) {
                    out[i] = read(d);
                }
            }
        }
        _ => {}
    }
    out
}

fn int_key(doc: &Document, dict: &Dictionary, keys: &[&str]) -> Option<i64> {
    for k in keys {
        if let Some(v) = pdf::dict_get(doc, dict, k).and_then(pdf::as_num) {
            return Some(v as i64);
        }
    }
    None
}

fn bool_key(doc: &Document, dict: &Dictionary, keys: &[&str]) -> Option<bool> {
    for k in keys {
        if let Some(Object::Boolean(b)) = pdf::dict_get(doc, dict, k) {
            return Some(*b);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpack_8bit_is_a_straight_copy() {
        let out = unpack_samples(&[1, 2, 3, 4], 2, 2, 1, 8, true);
        assert_eq!(out, vec![1, 2, 3, 4]);
    }

    #[test]
    fn unpack_8bit_pads_truncated_data() {
        let out = unpack_samples(&[9], 2, 2, 1, 8, true);
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], 9);
    }

    #[test]
    fn unpack_1bit_expands_to_0_and_255() {
        // 0b10000000 → pixel đầu 255, còn lại 0.
        let out = unpack_samples(&[0b1000_0000], 8, 1, 1, 1, true);
        assert_eq!(out[0], 255);
        assert_eq!(out[1], 0);
    }

    #[test]
    fn unpack_1bit_rows_start_on_byte_boundary() {
        // Ảnh rộng 3, 2 hàng, 1 bit: mỗi hàng chiếm 1 byte riêng.
        // Hàng 1 = 101xxxxx, hàng 2 = 010xxxxx.
        let out = unpack_samples(&[0b1010_0000, 0b0100_0000], 3, 2, 1, 1, true);
        assert_eq!(&out[0..3], &[255, 0, 255], "hàng 1");
        assert_eq!(&out[3..6], &[0, 255, 0], "hàng 2 phải bắt đầu ở byte mới");
    }

    #[test]
    fn unpack_4bit_scales_to_full_range() {
        // 0x0F → 0 rồi 255.
        let out = unpack_samples(&[0x0F], 2, 1, 1, 4, true);
        assert_eq!(out, vec![0, 255]);
    }

    #[test]
    fn unpack_16bit_keeps_high_byte() {
        let out = unpack_samples(&[0xAB, 0xCD], 1, 1, 1, 16, true);
        assert_eq!(out, vec![0xAB]);
    }

    #[test]
    fn adobe_marker_detection() {
        assert!(has_adobe_marker(b"\xFF\xD8\xFF\xEE\x00\x0EAdobe\x00d"));
        assert!(!has_adobe_marker(b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00"));
    }

    fn gray_image(samples: Vec<u8>, w: u32, h: u32, decode: Vec<f32>) -> SampledImage {
        SampledImage {
            width: w,
            height: h,
            n_comps: 1,
            samples,
            colorspace: Some(ColorSpace::DeviceGray),
            decode,
            bpc: 8,
            stencil: None,
            alpha: None,
        }
    }

    #[test]
    fn components_normalize_to_unit_range() {
        let img = gray_image(vec![0, 128, 255, 64], 2, 2, vec![]);
        assert_eq!(img.components_at(0, 0)[0], 0.0);
        assert!((img.components_at(0, 1)[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn decode_array_inverts_gray() {
        // `/Decode [1 0]` đảo ảnh. Bỏ qua nó = in ra âm bản.
        let img = gray_image(vec![0, 255], 2, 1, vec![1.0, 0.0]);
        assert!((img.components_at(0, 0)[0] - 1.0).abs() < 1e-6);
        assert!((img.components_at(1, 0)[0] - 0.0).abs() < 1e-6);
    }

    #[test]
    fn indexed_samples_are_palette_indices_not_intensities() {
        let img = SampledImage {
            width: 2,
            height: 1,
            n_comps: 1,
            samples: vec![0, 3],
            colorspace: Some(ColorSpace::Indexed {
                base: Box::new(ColorSpace::DeviceGray),
                hival: 3,
                lookup: std::sync::Arc::new(vec![255, 170, 85, 0]),
            }),
            decode: vec![],
            bpc: 8,
            stencil: None,
            alpha: None,
        };
        // Chỉ số phải giữ nguyên 0 và 3, KHÔNG chia 255.
        assert_eq!(img.components_at(0, 0)[0], 0.0);
        assert_eq!(img.components_at(1, 0)[0], 3.0);
    }

    #[test]
    fn indexed_lut_maps_palette_to_ink() {
        let img = SampledImage {
            width: 2,
            height: 1,
            n_comps: 1,
            samples: vec![0, 1],
            colorspace: Some(ColorSpace::Indexed {
                base: Box::new(ColorSpace::DeviceGray),
                hival: 1,
                lookup: std::sync::Arc::new(vec![255, 0]),
            }),
            decode: vec![],
            bpc: 8,
            stencil: None,
            alpha: None,
        };
        let mut space = InkSpace::new();
        let mut warn = RenderWarnings::default();
        let sampler = ImageSampler::new(&img, &mut space, &mut warn, None).unwrap();
        let (white, _) = sampler.ink_at(0, 0, &mut space, &mut warn, None).unwrap().unwrap();
        let (black, _) = sampler.ink_at(1, 0, &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(white[3], 0.0, "palette 0 là trắng");
        assert_eq!(black[3], 1.0, "palette 1 là đen K");
    }

    #[test]
    fn cmyk_image_ink_is_passed_through() {
        let img = SampledImage {
            width: 1,
            height: 1,
            n_comps: 4,
            samples: vec![255, 0, 0, 255],
            colorspace: Some(ColorSpace::DeviceCMYK),
            decode: vec![],
            bpc: 8,
            stencil: None,
            alpha: None,
        };
        let mut space = InkSpace::new();
        let mut warn = RenderWarnings::default();
        let sampler = ImageSampler::new(&img, &mut space, &mut warn, None).unwrap();
        let (ink, mask) = sampler.ink_at(0, 0, &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(ink[0], 1.0);
        assert_eq!(ink[3], 1.0);
        assert_eq!(mask, ChannelMask::PROCESS);
        // Ảnh CMYK là mực thật ⇒ không được hạ độ tin cậy.
        assert!(!warn.degrades_accuracy());
    }

    #[test]
    fn alpha_defaults_to_opaque_without_smask() {
        let img = gray_image(vec![0], 1, 1, vec![]);
        assert_eq!(img.alpha_at(0, 0), 1.0);
    }

    #[test]
    fn stencil_default_decode_paints_zero_samples() {
        let img = SampledImage {
            width: 2,
            height: 1,
            n_comps: 1,
            samples: vec![0, 255],
            colorspace: None,
            decode: vec![],
            bpc: 8,
            stencil: Some(vec![true, false]),
            alpha: None,
        };
        assert!(img.stencil_at(0, 0));
        assert!(!img.stencil_at(1, 0));
    }
}
