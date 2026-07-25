//! Phân giải colorspace PDF → mực.
//!
//! Đây là chỗ quyết định "spot có sống hay không". Nguyên tắc:
//!
//! * `Separation` / `DeviceN` **giữ kênh riêng** trong [`InkSpace`]. Tint đi
//!   thẳng vào kênh mực đó, KHÔNG qua tint transform. Tint transform chỉ dùng khi
//!   cần *xem* màu (soft-proof) hoặc *đổi* spot→CMYK, không dùng để tách kẽm.
//! * `Separation` mang tên process (`/Cyan`…) map về kênh process, không tạo spot
//!   thứ năm.
//! * `Separation /None` bị loại bỏ hoàn toàn (§8.6.6.4) — không vẽ gì.
//! * `Separation /All` đánh mực lên **mọi** kênh (crop mark in trên mọi kẽm).
//! * `ICCBased` quy về device space theo `/N`. Với `/N 4`, giá trị trong file
//!   **chính là** lượng mực CMYK ⇒ đo TAC vẫn đúng dù chưa áp ICC.

use std::sync::Arc;

use lopdf::{Dictionary, Document, Object};

use crate::color::convert;
use crate::color::function::PdfFunction;
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::color::icc::ColorManager;
use crate::ink::{ChannelMask, Colorant, InkSpace};
use crate::pdf;

/// Trần độ sâu lồng colorspace (Indexed của Separation của ICCBased…).
const MAX_CS_DEPTH: u32 = 8;

/// Colorspace PDF đã phân giải.
#[derive(Debug, Clone)]
pub enum ColorSpace {
    DeviceGray,
    DeviceRGB,
    DeviceCMYK,
    /// CIE L\*a\*b\*.
    Lab,
    /// `ICCBased` — giữ profile nhúng cho module ICC dùng sau; hiện quy về
    /// `alternate` theo `/N`.
    IccBased {
        alternate: Box<ColorSpace>,
        profile: Option<Arc<Vec<u8>>>,
    },
    Indexed {
        base: Box<ColorSpace>,
        hival: usize,
        lookup: Arc<Vec<u8>>,
    },
    /// Một mực. `colorant = None` nghĩa là `/None` — không bao giờ vẽ.
    Separation {
        colorant: Option<Colorant>,
        /// `true` nếu là `/All`.
        all: bool,
        alternate: Box<ColorSpace>,
        tint: Arc<PdfFunction>,
    },
    /// Nhiều mực. Phần tử `None` là `/None` (thành phần bị bỏ).
    DeviceN {
        colorants: Vec<Option<Colorant>>,
        alternate: Box<ColorSpace>,
        tint: Arc<PdfFunction>,
    },
    /// Pattern (tiling / shading). Interpreter xử lý riêng.
    Pattern { base: Option<Box<ColorSpace>> },
}

impl ColorSpace {
    /// Số thành phần màu mà operator `sc`/`scn`/`g`/`rg`/`k` cung cấp.
    pub fn n_components(&self) -> usize {
        match self {
            ColorSpace::DeviceGray => 1,
            ColorSpace::DeviceRGB => 3,
            ColorSpace::DeviceCMYK => 4,
            ColorSpace::Lab => 3,
            ColorSpace::IccBased { alternate, .. } => alternate.n_components(),
            ColorSpace::Indexed { .. } => 1,
            ColorSpace::Separation { .. } => 1,
            ColorSpace::DeviceN { colorants, .. } => colorants.len(),
            ColorSpace::Pattern { .. } => 1,
        }
    }

    /// Màu khởi tạo theo spec (§8.6.8): đen cho device space, 0 cho các loại khác.
    pub fn initial_components(&self) -> Vec<f32> {
        match self {
            ColorSpace::DeviceGray => vec![0.0],
            ColorSpace::DeviceRGB => vec![0.0, 0.0, 0.0],
            ColorSpace::DeviceCMYK => vec![0.0, 0.0, 0.0, 1.0],
            ColorSpace::Lab => vec![0.0, 0.0, 0.0],
            ColorSpace::IccBased { alternate, .. } => alternate.initial_components(),
            ColorSpace::Indexed { .. } => vec![0.0],
            ColorSpace::Separation { .. } => vec![1.0],
            ColorSpace::DeviceN { colorants, .. } => vec![1.0; colorants.len()],
            ColorSpace::Pattern { .. } => vec![0.0],
        }
    }

    /// Quy màu nguồn về lượng mực.
    ///
    /// Trả `Ok(None)` khi thao tác vẽ phải bị **loại bỏ** (colorant `/None`).
    /// Đó không phải lỗi: spec yêu cầu bỏ, và bỏ đúng cách quan trọng vì kênh
    /// `/None` hay được dùng làm ghi chú kỹ thuật không được lên kẽm.
    pub fn to_ink(
        &self,
        comps: &[f32],
        space: &mut InkSpace,
        warn: &mut RenderWarnings,
        cm: Option<&ColorManager>,
    ) -> PpeResult<Option<(Vec<f32>, ChannelMask)>> {
        self.to_ink_depth(comps, space, warn, cm, 0)
    }

    fn to_ink_depth(
        &self,
        comps: &[f32],
        space: &mut InkSpace,
        warn: &mut RenderWarnings,
        cm: Option<&ColorManager>,
        depth: u32,
    ) -> PpeResult<Option<(Vec<f32>, ChannelMask)>> {
        if depth > MAX_CS_DEPTH {
            return Err(PpeError::MalformedPdf("colorspace lồng quá sâu".into()));
        }

        match self {
            ColorSpace::DeviceCMYK => {
                warn.note_colorspace_used("DeviceCMYK");
                let c = comp(comps, 0);
                let m = comp(comps, 1);
                let y = comp(comps, 2);
                let k = comp(comps, 3);
                Ok(Some((spread_cmyk([c, m, y, k], space), ChannelMask::PROCESS)))
            }

            ColorSpace::DeviceGray => {
                warn.note_colorspace_used("DeviceGray");
                let cmyk = convert::gray_to_cmyk(comp(comps, 0));
                // DeviceGray chỉ khai báo kênh K. Nhờ vậy chữ xám overprint không
                // khoét C/M/Y của nền — đúng hành vi RIP.
                Ok(Some((spread_cmyk(cmyk, space), ChannelMask::single(3))))
            }

            ColorSpace::DeviceRGB => {
                warn.note_colorspace_used("DeviceRGB");
                // Lượng mực của một vùng RGB phụ thuộc hoàn toàn vào black
                // generation và gamut mapping của profile đích. Có ICC thì đây là
                // con số dùng được; không có thì chỉ là phỏng đoán.
                let cmyk = match cm.and_then(|cm| {
                    cm.rgb_to_cmyk(comp(comps, 0), comp(comps, 1), comp(comps, 2))
                }) {
                    Some(c) => c,
                    None => {
                        warn.note_approximated_colorspace("DeviceRGB→CMYK không ICC");
                        convert::rgb_to_cmyk_naive(comp(comps, 0), comp(comps, 1), comp(comps, 2))
                    }
                };
                Ok(Some((spread_cmyk(cmyk, space), ChannelMask::PROCESS)))
            }

            ColorSpace::Lab => {
                warn.note_colorspace_used("Lab");
                let cmyk = match cm.and_then(|cm| {
                    cm.lab_to_cmyk(comp(comps, 0), comp(comps, 1), comp(comps, 2))
                }) {
                    Some(c) => c,
                    None => {
                        warn.note_approximated_colorspace("Lab→CMYK không ICC");
                        convert::lab_to_cmyk_naive(comp(comps, 0), comp(comps, 1), comp(comps, 2))
                    }
                };
                Ok(Some((spread_cmyk(cmyk, space), ChannelMask::PROCESS)))
            }

            ColorSpace::IccBased { alternate, profile } => {
                warn.note_colorspace_used("ICCBased");
                // `/N 4`: giá trị trong file **chính là** lượng mực. Không đưa qua
                // ICC — round-trip sẽ nén 400% xuống ~292% và làm file vượt giới
                // hạn mực bị báo là đạt.
                if matches!(**alternate, ColorSpace::DeviceCMYK) {
                    return alternate.to_ink_depth(comps, space, warn, cm, depth + 1);
                }

                // 3 kênh: dùng đúng profile nhúng trong file, không giả định sRGB.
                if matches!(**alternate, ColorSpace::DeviceRGB) {
                    if let (Some(cm), Some(bytes)) = (cm, profile.as_ref()) {
                        if let Some(cmyk) = cm.embedded_to_cmyk(
                            bytes,
                            comp(comps, 0),
                            comp(comps, 1),
                            comp(comps, 2),
                        ) {
                            return Ok(Some((spread_cmyk(cmyk, space), ChannelMask::PROCESS)));
                        }
                        // Profile nhúng hỏng: hạ cờ rồi mới lùi về sRGB. Lặng lẽ
                        // coi như sRGB sẽ cho màu sai mà không ai biết.
                        warn.note_approximated_colorspace(
                            "ICCBased: profile nhúng không đọc được, dùng sRGB",
                        );
                    }
                }

                // 1 kênh ICCBased: file đã khai rõ muốn quản lý màu ⇒ tôn trọng.
                // (Khác `DeviceGray`, vốn map thẳng về K để chữ nhỏ không thành
                // rich black.)
                if matches!(**alternate, ColorSpace::DeviceGray) {
                    if let Some(cmyk) = cm.and_then(|cm| cm.gray_to_cmyk(comp(comps, 0))) {
                        return Ok(Some((spread_cmyk(cmyk, space), ChannelMask::PROCESS)));
                    }
                }

                alternate.to_ink_depth(comps, space, warn, cm, depth + 1)
            }

            ColorSpace::Indexed { base, hival, lookup } => {
                warn.note_colorspace_used("Indexed");
                let idx = (comp(comps, 0).round().max(0.0) as usize).min(*hival);
                let n = base.n_components();
                let mut base_comps = Vec::with_capacity(n);
                for i in 0..n {
                    let byte = lookup.get(idx * n + i).copied().unwrap_or(0);
                    base_comps.push(decode_indexed_component(base, i, byte));
                }
                base.to_ink_depth(&base_comps, space, warn, cm, depth + 1)
            }

            ColorSpace::Separation { colorant, all, alternate, tint } => {
                warn.note_colorspace_used("Separation");
                let t = comp(comps, 0).clamp(0.0, 1.0);
                if *all {
                    // `/All`: đánh mực lên mọi kẽm.
                    let mask = space.all_channels_mask();
                    let ink = vec![t; space.len()];
                    return Ok(Some((ink, mask)));
                }
                let Some(colorant) = colorant else {
                    return Ok(None); // `/None` — không vẽ
                };
                let ch = space.register(colorant.clone())?;
                let mut ink = vec![0.0; space.len()];
                ink[ch] = t;
                let _ = (alternate, tint); // dành cho soft-proof / spot→CMYK
                Ok(Some((ink, ChannelMask::single(ch))))
            }

            ColorSpace::DeviceN { colorants, alternate, tint } => {
                warn.note_colorspace_used("DeviceN");
                let mut ink: Vec<f32> = vec![0.0; space.len()];
                let mut mask = ChannelMask::EMPTY;
                let mut any = false;
                for (i, colorant) in colorants.iter().enumerate() {
                    let Some(colorant) = colorant else {
                        continue; // thành phần `/None`
                    };
                    let ch = space.register(colorant.clone())?;
                    if ink.len() < space.len() {
                        ink.resize(space.len(), 0.0);
                    }
                    // Tên trùng trong DeviceN: lấy giá trị lớn hơn thay vì cộng —
                    // cộng sẽ báo TAC cao giả.
                    let t = comp(comps, i).clamp(0.0, 1.0);
                    ink[ch] = ink[ch].max(t);
                    mask = mask.with(ch);
                    any = true;
                }
                if !any {
                    return Ok(None);
                }
                let _ = (alternate, tint);
                Ok(Some((ink, mask)))
            }

            ColorSpace::Pattern { .. } => {
                // Pattern không có màu vô hướng; interpreter phải dựng nội dung
                // pattern. Trả None để không vẽ khối đen sai.
                Ok(None)
            }
        }
    }

    /// Tint transform, nếu colorspace có (Separation/DeviceN).
    ///
    /// Dùng cho soft-proof composite và action Spot→CMYK.
    pub fn tint_transform(&self) -> Option<(&PdfFunction, &ColorSpace)> {
        match self {
            ColorSpace::Separation { tint, alternate, .. } => Some((tint, alternate)),
            ColorSpace::DeviceN { tint, alternate, .. } => Some((tint, alternate)),
            _ => None,
        }
    }
}

fn comp(comps: &[f32], i: usize) -> f32 {
    comps.get(i).copied().unwrap_or(0.0)
}

/// Đặt CMYK vào vector mực đủ độ dài của [`InkSpace`].
fn spread_cmyk(cmyk: [f32; 4], space: &InkSpace) -> Vec<f32> {
    let mut ink = vec![0.0; space.len()];
    for i in 0..4 {
        ink[i] = cmyk[i].clamp(0.0, 1.0);
    }
    ink
}

/// Giải mã một byte trong bảng `Indexed` về khoảng của base space.
///
/// Lab có khoảng khác 0..1 nên không thể chia 255 một cách mù quáng.
fn decode_indexed_component(base: &ColorSpace, i: usize, byte: u8) -> f32 {
    let v = byte as f32 / 255.0;
    match base {
        ColorSpace::Lab => match i {
            0 => v * 100.0,
            _ => v * 255.0 - 128.0,
        },
        _ => v,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phân giải từ object PDF
// ─────────────────────────────────────────────────────────────────────────────

/// Phân giải một colorspace: có thể là tên device, tên trong `/ColorSpace` của
/// resources, hoặc mảng `[/Family …]`.
pub fn resolve_colorspace(
    doc: &Document,
    obj: &Object,
    resources: Option<&Dictionary>,
    warn: &mut RenderWarnings,
) -> PpeResult<ColorSpace> {
    resolve_cs_depth(doc, obj, resources, warn, 0)
}

fn resolve_cs_depth(
    doc: &Document,
    obj: &Object,
    resources: Option<&Dictionary>,
    warn: &mut RenderWarnings,
    depth: u32,
) -> PpeResult<ColorSpace> {
    if depth > MAX_CS_DEPTH {
        return Err(PpeError::MalformedPdf("colorspace lồng quá sâu".into()));
    }
    let obj = pdf::deref(doc, obj);

    if let Some(name) = pdf::name_str(obj) {
        return resolve_cs_name(doc, &name, resources, warn, depth);
    }

    let arr = match obj {
        Object::Array(a) => a,
        _ => {
            return Err(PpeError::MalformedPdf(
                "colorspace không phải tên hay mảng".into(),
            ))
        }
    };
    if arr.is_empty() {
        return Err(PpeError::MalformedPdf("mảng colorspace rỗng".into()));
    }

    let family = pdf::name_str(pdf::deref(doc, &arr[0]))
        .ok_or_else(|| PpeError::MalformedPdf("colorspace thiếu tên họ".into()))?;

    match family.as_str() {
        // Mảng một phần tử: [/DeviceRGB] v.v.
        "DeviceGray" | "G" => Ok(ColorSpace::DeviceGray),
        "DeviceRGB" | "RGB" => Ok(ColorSpace::DeviceRGB),
        "DeviceCMYK" | "CMYK" => Ok(ColorSpace::DeviceCMYK),
        "CalGray" => Ok(ColorSpace::DeviceGray),
        "CalRGB" => Ok(ColorSpace::DeviceRGB),
        "Lab" => Ok(ColorSpace::Lab),

        "ICCBased" => {
            let stream_obj = arr.get(1).map(|o| pdf::deref(doc, o));
            let (n, profile) = match stream_obj {
                Some(Object::Stream(s)) => {
                    let n = pdf::dict_get(doc, &s.dict, "N")
                        .and_then(pdf::as_num)
                        .unwrap_or(3.0) as usize;
                    let bytes = s.decompressed_content().ok().map(Arc::new);
                    (n, bytes)
                }
                _ => (3, None),
            };
            let alternate = match n {
                1 => ColorSpace::DeviceGray,
                4 => ColorSpace::DeviceCMYK,
                _ => ColorSpace::DeviceRGB,
            };
            Ok(ColorSpace::IccBased {
                alternate: Box::new(alternate),
                profile,
            })
        }

        "Indexed" | "I" => {
            let base = resolve_cs_depth(
                doc,
                arr.get(1).unwrap_or(&Object::Null),
                resources,
                warn,
                depth + 1,
            )?;
            let hival = arr
                .get(2)
                .and_then(|o| pdf::num(doc, o))
                .unwrap_or(0.0)
                .max(0.0) as usize;
            let lookup = match arr.get(3).map(|o| pdf::deref(doc, o)) {
                Some(Object::String(bytes, _)) => bytes.clone(),
                Some(Object::Stream(_)) => {
                    pdf::stream_data(doc, arr.get(3).unwrap()).unwrap_or_default()
                }
                _ => Vec::new(),
            };
            Ok(ColorSpace::Indexed {
                base: Box::new(base),
                hival: hival.min(255),
                lookup: Arc::new(lookup),
            })
        }

        "Separation" => {
            let name = arr
                .get(1)
                .and_then(|o| pdf::name_str(pdf::deref(doc, o)))
                .unwrap_or_default();
            let alternate = arr
                .get(2)
                .map(|o| resolve_cs_depth(doc, o, resources, warn, depth + 1))
                .transpose()?
                .unwrap_or(ColorSpace::DeviceCMYK);
            let tint = arr
                .get(3)
                .map(|o| resolve_function(doc, o))
                .transpose()?
                .unwrap_or(PdfFunction::Identity {
                    n_out: alternate.n_components(),
                });

            let all = InkSpace::is_all_colorant(&name);
            let colorant = if InkSpace::is_none_colorant(&name) || all {
                None
            } else {
                Some(Colorant::from_pdf_name(&name))
            };
            Ok(ColorSpace::Separation {
                colorant,
                all,
                alternate: Box::new(alternate),
                tint: Arc::new(tint),
            })
        }

        "DeviceN" => {
            let names: Vec<String> = match arr.get(1).map(|o| pdf::deref(doc, o)) {
                Some(Object::Array(items)) => items
                    .iter()
                    .map(|o| pdf::name_str(pdf::deref(doc, o)).unwrap_or_default())
                    .collect(),
                _ => Vec::new(),
            };
            if names.is_empty() {
                return Err(PpeError::MalformedPdf("DeviceN không có tên mực".into()));
            }
            let alternate = arr
                .get(2)
                .map(|o| resolve_cs_depth(doc, o, resources, warn, depth + 1))
                .transpose()?
                .unwrap_or(ColorSpace::DeviceCMYK);
            let tint = arr
                .get(3)
                .map(|o| resolve_function(doc, o))
                .transpose()?
                .unwrap_or(PdfFunction::Identity {
                    n_out: alternate.n_components(),
                });
            let colorants = names
                .iter()
                .map(|n| {
                    if InkSpace::is_none_colorant(n) {
                        None
                    } else {
                        Some(Colorant::from_pdf_name(n))
                    }
                })
                .collect();
            Ok(ColorSpace::DeviceN {
                colorants,
                alternate: Box::new(alternate),
                tint: Arc::new(tint),
            })
        }

        "Pattern" => {
            let base = arr
                .get(1)
                .map(|o| resolve_cs_depth(doc, o, resources, warn, depth + 1))
                .transpose()?
                .map(Box::new);
            Ok(ColorSpace::Pattern { base })
        }

        other => Err(PpeError::Unsupported(format!("colorspace {other}"))),
    }
}

fn resolve_cs_name(
    doc: &Document,
    name: &str,
    resources: Option<&Dictionary>,
    warn: &mut RenderWarnings,
    depth: u32,
) -> PpeResult<ColorSpace> {
    match name {
        "DeviceGray" | "G" | "CalGray" => return Ok(ColorSpace::DeviceGray),
        "DeviceRGB" | "RGB" | "CalRGB" => return Ok(ColorSpace::DeviceRGB),
        "DeviceCMYK" | "CMYK" => return Ok(ColorSpace::DeviceCMYK),
        "Pattern" => return Ok(ColorSpace::Pattern { base: None }),
        _ => {}
    }
    // Tên do resources định nghĩa (`/CS0 cs`).
    if let Some(res) = resources {
        if let Some(cs_dict) = pdf::dict_get_dict(doc, res, "ColorSpace") {
            if let Ok(entry) = cs_dict.get(name.as_bytes()) {
                let entry = entry.clone();
                return resolve_cs_depth(doc, &entry, resources, warn, depth + 1);
            }
        }
    }
    Err(PpeError::Unsupported(format!(
        "colorspace tên `{name}` không có trong Resources"
    )))
}

/// Phân giải một PDF Function (dict hoặc stream, hoặc mảng hàm).
pub fn resolve_function(doc: &Document, obj: &Object) -> PpeResult<PdfFunction> {
    let resolved = pdf::deref(doc, obj);

    // Mảng hàm: mỗi hàm cho một kênh output. Ghép thành một hàm nhiều output.
    if let Object::Array(items) = resolved {
        if items.is_empty() {
            return Ok(PdfFunction::Identity { n_out: 1 });
        }
        // Trường hợp phổ biến: mảng n hàm 1-in 1-out.
        let mut parts = Vec::with_capacity(items.len());
        for it in items {
            parts.push(resolve_function(doc, it)?);
        }
        return Ok(combine_functions(parts));
    }

    let dict = match resolved {
        Object::Dictionary(d) => d,
        Object::Stream(s) => &s.dict,
        _ => return Err(PpeError::MalformedPdf("function không phải dict/stream".into())),
    };

    let ftype = pdf::dict_get(doc, dict, "FunctionType")
        .and_then(pdf::as_num)
        .ok_or_else(|| PpeError::MalformedPdf("function thiếu FunctionType".into()))?
        as i32;

    let domain = pdf::dict_get(doc, dict, "Domain")
        .and_then(|o| pdf::num_array(doc, o))
        .unwrap_or_else(|| vec![0.0, 1.0]);
    let range = pdf::dict_get(doc, dict, "Range").and_then(|o| pdf::num_array(doc, o));

    match ftype {
        2 => {
            let c0 = pdf::dict_get(doc, dict, "C0")
                .and_then(|o| pdf::num_array(doc, o))
                .unwrap_or_else(|| vec![0.0]);
            let c1 = pdf::dict_get(doc, dict, "C1")
                .and_then(|o| pdf::num_array(doc, o))
                .unwrap_or_else(|| vec![1.0]);
            let n = pdf::dict_get(doc, dict, "N")
                .and_then(pdf::as_num)
                .unwrap_or(1.0);
            // C0/C1 phải cùng độ dài; file lệch thì đệm 0 thay vì panic.
            let len = c0.len().max(c1.len());
            let mut c0 = c0;
            let mut c1 = c1;
            c0.resize(len, 0.0);
            c1.resize(len, 0.0);
            Ok(PdfFunction::Exponential { domain, c0, c1, n, range })
        }

        3 => {
            let functions = match pdf::dict_get(doc, dict, "Functions") {
                Some(Object::Array(items)) => {
                    let mut out = Vec::with_capacity(items.len());
                    for it in items {
                        out.push(resolve_function(doc, it)?);
                    }
                    out
                }
                _ => return Err(PpeError::MalformedPdf("function kiểu 3 thiếu Functions".into())),
            };
            if functions.is_empty() {
                return Err(PpeError::MalformedPdf("function kiểu 3 có Functions rỗng".into()));
            }
            let bounds = pdf::dict_get(doc, dict, "Bounds")
                .and_then(|o| pdf::num_array(doc, o))
                .unwrap_or_default();
            let encode = pdf::dict_get(doc, dict, "Encode")
                .and_then(|o| pdf::num_array(doc, o))
                .unwrap_or_else(|| {
                    (0..functions.len()).flat_map(|_| [0.0, 1.0]).collect()
                });
            Ok(PdfFunction::Stitching { domain, functions, bounds, encode, range })
        }

        0 => {
            let data = pdf::stream_data(doc, obj)
                .ok_or_else(|| PpeError::MalformedPdf("function kiểu 0 không đọc được stream".into()))?;
            let size: Vec<usize> = pdf::dict_get(doc, dict, "Size")
                .and_then(|o| pdf::num_array(doc, o))
                .map(|v| v.iter().map(|s| (*s).max(1.0) as usize).collect())
                .ok_or_else(|| PpeError::MalformedPdf("function kiểu 0 thiếu Size".into()))?;
            let bps = pdf::dict_get(doc, dict, "BitsPerSample")
                .and_then(pdf::as_num)
                .ok_or_else(|| PpeError::MalformedPdf("function kiểu 0 thiếu BitsPerSample".into()))?
                as u32;
            let range = range
                .ok_or_else(|| PpeError::MalformedPdf("function kiểu 0 thiếu Range".into()))?;
            let n_out = range.len() / 2;
            if n_out == 0 {
                return Err(PpeError::MalformedPdf("function kiểu 0 có Range rỗng".into()));
            }
            let encode = pdf::dict_get(doc, dict, "Encode")
                .and_then(|o| pdf::num_array(doc, o))
                .unwrap_or_else(|| {
                    size.iter().flat_map(|s| [0.0, (*s - 1) as f32]).collect()
                });
            let decode = pdf::dict_get(doc, dict, "Decode")
                .and_then(|o| pdf::num_array(doc, o))
                .unwrap_or_else(|| range.clone());
            let total: usize = size.iter().product::<usize>() * n_out;
            let samples = unpack_samples(&data, bps, total);
            Ok(PdfFunction::Sampled {
                domain,
                range,
                size,
                encode,
                decode,
                samples,
                n_out,
            })
        }

        4 => {
            let data = pdf::stream_data(doc, obj)
                .ok_or_else(|| PpeError::MalformedPdf("function kiểu 4 không đọc được stream".into()))?;
            let range = range
                .ok_or_else(|| PpeError::MalformedPdf("function kiểu 4 thiếu Range".into()))?;
            let program = crate::color::function::parse_ps_program(&data)?;
            Ok(PdfFunction::PostScript { domain, range, program })
        }

        other => Err(PpeError::Unsupported(format!("FunctionType {other}"))),
    }
}

/// Ghép n hàm 1-output thành một hàm n-output.
fn combine_functions(parts: Vec<PdfFunction>) -> PdfFunction {
    if parts.len() == 1 {
        return parts.into_iter().next().unwrap();
    }
    // Biểu diễn bằng Stitching là sai ngữ nghĩa; dùng bảng mẫu hoá 1 chiều để
    // giữ đúng "mỗi hàm một kênh output".
    const STEPS: usize = 65;
    let n_out = parts.len();
    let mut samples = Vec::with_capacity(STEPS * n_out);
    for s in 0..STEPS {
        let x = s as f32 / (STEPS - 1) as f32;
        for p in &parts {
            samples.push(p.eval(&[x]).first().copied().unwrap_or(0.0));
        }
    }
    PdfFunction::Sampled {
        domain: vec![0.0, 1.0],
        range: (0..n_out).flat_map(|_| [0.0, 1.0]).collect(),
        size: vec![STEPS],
        encode: vec![0.0, (STEPS - 1) as f32],
        decode: (0..n_out).flat_map(|_| [0.0, 1.0]).collect(),
        samples,
        n_out,
    }
}

/// Giải nén mẫu `BitsPerSample` bit → f32 chuẩn hoá 0..1.
fn unpack_samples(data: &[u8], bps: u32, count: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(count);
    let max = ((1u64 << bps.min(32)) - 1) as f32;
    match bps {
        8 => {
            for i in 0..count {
                out.push(data.get(i).copied().unwrap_or(0) as f32 / 255.0);
            }
        }
        16 => {
            for i in 0..count {
                let hi = data.get(i * 2).copied().unwrap_or(0) as u32;
                let lo = data.get(i * 2 + 1).copied().unwrap_or(0) as u32;
                out.push(((hi << 8) | lo) as f32 / 65535.0);
            }
        }
        _ => {
            let mut bitpos = 0usize;
            for _ in 0..count {
                let mut v: u64 = 0;
                for _ in 0..bps {
                    let byte = data.get(bitpos / 8).copied().unwrap_or(0);
                    let bit = (byte >> (7 - (bitpos % 8))) & 1;
                    v = (v << 1) | bit as u64;
                    bitpos += 1;
                }
                out.push(v as f32 / max);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::function::PdfFunction;

    fn ink4() -> InkSpace {
        InkSpace::new()
    }

    fn sep(name: &str) -> ColorSpace {
        ColorSpace::Separation {
            colorant: if InkSpace::is_none_colorant(name) || InkSpace::is_all_colorant(name) {
                None
            } else {
                Some(Colorant::from_pdf_name(name))
            },
            all: InkSpace::is_all_colorant(name),
            alternate: Box::new(ColorSpace::DeviceCMYK),
            tint: Arc::new(PdfFunction::Identity { n_out: 4 }),
        }
    }

    #[test]
    fn device_cmyk_passes_ink_through_untouched() {
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (ink, mask) = ColorSpace::DeviceCMYK
            .to_ink(&[0.1, 0.2, 0.3, 0.4], &mut space, &mut warn, None)
            .unwrap()
            .unwrap();
        assert_eq!(&ink[..4], &[0.1, 0.2, 0.3, 0.4]);
        assert_eq!(mask, ChannelMask::PROCESS);
        // Không có quy đổi ⇒ không được hạ độ tin cậy.
        assert!(!warn.degrades_accuracy());
    }

    #[test]
    fn device_gray_declares_only_black_channel() {
        // Nếu khai báo cả 4 kênh, chữ xám overprint sẽ khoét nền — lỗi in thật.
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (ink, mask) = ColorSpace::DeviceGray
            .to_ink(&[0.0], &mut space, &mut warn, None)
            .unwrap()
            .unwrap();
        assert_eq!(ink[3], 1.0);
        assert!(mask.contains(3));
        assert!(!mask.contains(0));
    }

    #[test]
    fn device_rgb_flags_approximation() {
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        ColorSpace::DeviceRGB
            .to_ink(&[1.0, 0.0, 0.0], &mut space, &mut warn, None)
            .unwrap()
            .unwrap();
        assert!(warn.degrades_accuracy(), "RGB không ICC phải hạ accuracy");
    }

    #[test]
    fn icc_based_cmyk_is_not_flagged_approximate_for_ink() {
        // /N 4 = giá trị mực thật trong file ⇒ TAC đúng, không cần hạ cờ.
        let cs = ColorSpace::IccBased {
            alternate: Box::new(ColorSpace::DeviceCMYK),
            profile: None,
        };
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (ink, _) = cs.to_ink(&[0.0, 0.0, 0.0, 1.0], &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(ink[3], 1.0);
        assert!(!warn.degrades_accuracy());
    }

    #[test]
    fn separation_spot_gets_its_own_channel() {
        let cs = sep("PANTONE 485 C");
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (ink, mask) = cs.to_ink(&[1.0], &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(space.len(), 5);
        assert_eq!(ink[4], 1.0);
        assert_eq!(&ink[..4], &[0.0, 0.0, 0.0, 0.0], "spot KHÔNG được rơi vào process");
        assert_eq!(mask, ChannelMask::single(4));
    }

    #[test]
    fn separation_named_cyan_uses_process_channel() {
        let cs = sep("Cyan");
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (ink, mask) = cs.to_ink(&[0.5], &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(space.len(), 4, "không được sinh kẽm spot thứ năm");
        assert_eq!(ink[0], 0.5);
        assert_eq!(mask, ChannelMask::single(0));
    }

    #[test]
    fn separation_none_is_not_painted() {
        let cs = sep("None");
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        assert!(cs.to_ink(&[1.0], &mut space, &mut warn, None).unwrap().is_none());
        assert_eq!(space.len(), 4, "/None không được tạo kênh");
    }

    #[test]
    fn separation_all_paints_every_channel() {
        let cs = sep("All");
        let mut space = ink4();
        space.register(Colorant::Spot("Varnish".into())).unwrap();
        let mut warn = RenderWarnings::default();
        let (ink, mask) = cs.to_ink(&[1.0], &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(ink.len(), 5);
        assert!(ink.iter().all(|v| *v == 1.0));
        for i in 0..5 {
            assert!(mask.contains(i));
        }
    }

    #[test]
    fn devicen_maps_each_name_to_its_channel() {
        let cs = ColorSpace::DeviceN {
            colorants: vec![
                Some(Colorant::from_pdf_name("Cyan")),
                Some(Colorant::from_pdf_name("PANTONE 485 C")),
                None, // /None
            ],
            alternate: Box::new(ColorSpace::DeviceCMYK),
            tint: Arc::new(PdfFunction::Identity { n_out: 4 }),
        };
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (ink, mask) = cs.to_ink(&[0.3, 0.7, 1.0], &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(space.len(), 5);
        assert_eq!(ink[0], 0.3);
        assert_eq!(ink[4], 0.7);
        assert!(mask.contains(0) && mask.contains(4));
        assert_eq!(mask, ChannelMask::single(0).with(4), "/None không được khai báo");
    }

    #[test]
    fn devicen_all_none_paints_nothing() {
        let cs = ColorSpace::DeviceN {
            colorants: vec![None, None],
            alternate: Box::new(ColorSpace::DeviceCMYK),
            tint: Arc::new(PdfFunction::Identity { n_out: 4 }),
        };
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        assert!(cs.to_ink(&[1.0, 1.0], &mut space, &mut warn, None).unwrap().is_none());
    }

    #[test]
    fn indexed_looks_up_base_components() {
        // Palette 2 màu: trắng, đen (DeviceGray).
        let cs = ColorSpace::Indexed {
            base: Box::new(ColorSpace::DeviceGray),
            hival: 1,
            lookup: Arc::new(vec![255, 0]),
        };
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (white, _) = cs.to_ink(&[0.0], &mut space, &mut warn, None).unwrap().unwrap();
        let (black, _) = cs.to_ink(&[1.0], &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(white[3], 0.0);
        assert_eq!(black[3], 1.0);
    }

    #[test]
    fn indexed_clamps_out_of_range_index() {
        let cs = ColorSpace::Indexed {
            base: Box::new(ColorSpace::DeviceGray),
            hival: 1,
            lookup: Arc::new(vec![255, 0]),
        };
        let mut space = ink4();
        let mut warn = RenderWarnings::default();
        let (v, _) = cs.to_ink(&[99.0], &mut space, &mut warn, None).unwrap().unwrap();
        assert_eq!(v[3], 1.0, "index vượt hival phải kẹp về hival");
    }

    #[test]
    fn initial_color_is_black_per_spec() {
        assert_eq!(ColorSpace::DeviceCMYK.initial_components(), vec![0.0, 0.0, 0.0, 1.0]);
        assert_eq!(ColorSpace::DeviceGray.initial_components(), vec![0.0]);
        assert_eq!(ColorSpace::DeviceRGB.initial_components(), vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn n_components_matches_family() {
        assert_eq!(ColorSpace::DeviceCMYK.n_components(), 4);
        assert_eq!(sep("PANTONE 485 C").n_components(), 1);
        let dn = ColorSpace::DeviceN {
            colorants: vec![None, None, None],
            alternate: Box::new(ColorSpace::DeviceCMYK),
            tint: Arc::new(PdfFunction::Identity { n_out: 4 }),
        };
        assert_eq!(dn.n_components(), 3);
    }

    #[test]
    fn unpack_8bit_samples() {
        let s = unpack_samples(&[0, 128, 255], 8, 3);
        assert!((s[0] - 0.0).abs() < 1e-6);
        assert!((s[1] - 0.50196).abs() < 1e-4);
        assert!((s[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn unpack_16bit_samples() {
        let s = unpack_samples(&[0xFF, 0xFF, 0x00, 0x00], 16, 2);
        assert!((s[0] - 1.0).abs() < 1e-6);
        assert!((s[1] - 0.0).abs() < 1e-6);
    }

    #[test]
    fn unpack_1bit_samples() {
        // 0b10100000 → 1,0,1,0,0,0,0,0
        let s = unpack_samples(&[0b1010_0000], 1, 4);
        assert_eq!(s, vec![1.0, 0.0, 1.0, 0.0]);
    }

    #[test]
    fn unpack_4bit_samples() {
        let s = unpack_samples(&[0x0F, 0xF0], 4, 4);
        assert_eq!(s, vec![0.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn unpack_tolerates_truncated_data() {
        let s = unpack_samples(&[1], 8, 5);
        assert_eq!(s.len(), 5, "thiếu dữ liệu phải đệm, không panic");
    }

    #[test]
    fn combine_functions_keeps_one_output_per_part() {
        let a = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![0.0],
            c1: vec![1.0],
            n: 1.0,
            range: None,
        };
        let b = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![1.0],
            c1: vec![0.0],
            n: 1.0,
            range: None,
        };
        let combined = combine_functions(vec![a, b]);
        let out = combined.eval(&[0.0]);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.0).abs() < 1e-3, "{out:?}");
        assert!((out[1] - 1.0).abs() < 1e-3, "{out:?}");
    }
}
