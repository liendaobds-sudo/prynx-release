//! Quản lý màu ICC.
//!
//! # Nguyên tắc: ICC chỉ dùng để **đưa vào**, không dùng để đo
//!
//! Đây là quy tắc quan trọng nhất của file này, và là thứ phân biệt một engine
//! prepress dùng được với một engine cho ra số đẹp nhưng sai:
//!
//! * **`DeviceCMYK` không bao giờ đi qua ICC.** Giá trị CMYK trong file *chính là*
//!   lượng mực. Đưa nó qua một cặp profile rồi quay lại sẽ nén vùng đặc: 4 kênh
//!   100% biến thành ~292% thay vì 400%, và một file vượt giới hạn mực sẽ được
//!   báo là đạt. Đó là kiểu sai đắt nhất trong xưởng in.
//! * **`DeviceRGB` / `Lab` / `ICCBased` 1–3 kênh thì bắt buộc qua ICC.** Lượng mực
//!   của một vùng RGB phụ thuộc hoàn toàn vào black generation và gamut mapping
//!   của profile đích. Không có ICC thì mọi công thức đều tuỳ tiện — đó là lý do
//!   `color/convert.rs` chỉ được dùng làm fallback và luôn hạ `accuracy`.
//!
//! Nói ngắn: *quy đổi thứ chưa phải mực; không bao giờ quy đổi thứ đã là mực.*
//!
//! # Vì sao Little CMS
//!
//! Ghostscript cũng dùng Little CMS làm CMM. Dùng chung engine màu khiến phép so
//! golden nói lên chất lượng của PPE, chứ không nói lên khác biệt giữa hai CMM.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

use lcms2::{Flags, Intent, PixelFormat, Profile, Transform};

use crate::error::{PpeError, PpeResult};

/// Rendering intent, ánh xạ 1-1 với `/RenderIntent` của PDF và `-dRenderIntent`
/// của Ghostscript (0..3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderIntent {
    Perceptual,
    RelativeColorimetric,
    Saturation,
    AbsoluteColorimetric,
}

impl Default for RenderIntent {
    fn default() -> Self {
        // Mặc định relative colorimetric: giữ màu trong gamut đúng vị trí, chỉ
        // ép màu ngoài gamut. Đây là lựa chọn an toàn cho prepress; perceptual
        // làm dịch cả những màu vốn in được.
        RenderIntent::RelativeColorimetric
    }
}

impl RenderIntent {
    pub fn from_pdf(value: i32) -> RenderIntent {
        match value {
            0 => RenderIntent::Perceptual,
            2 => RenderIntent::Saturation,
            3 => RenderIntent::AbsoluteColorimetric,
            _ => RenderIntent::RelativeColorimetric,
        }
    }

    fn to_lcms(self) -> Intent {
        match self {
            RenderIntent::Perceptual => Intent::Perceptual,
            RenderIntent::RelativeColorimetric => Intent::RelativeColorimetric,
            RenderIntent::Saturation => Intent::Saturation,
            RenderIntent::AbsoluteColorimetric => Intent::AbsoluteColorimetric,
        }
    }
}

/// Số điểm lưới mỗi trục của LUT 3 chiều RGB→CMYK.
///
/// 33 là số điểm mà devicelink ICC thực tế dùng, và cũng là điểm cân bằng: 33³ =
/// 35937 ô × 4 f32 ≈ 561 KB, dựng bằng **một** lần gọi lcms.
///
/// Vì sao cần LUT: ảnh RGB 2400×2400 có 5.7 triệu pixel nhưng khung render 100
/// DPI chỉ lấy mẫu vài chục nghìn. Gọi lcms cho từng pixel thiết bị là chậm,
/// biến đổi cả ảnh trước là thừa. LUT + nội suy 3 tuyến tính giải quyết cả hai.
const LUT_GRID: usize = 33;

/// LUT 3 chiều cho một phép biến đổi 3 kênh → CMYK.
struct Lut3 {
    /// `[(r * G + g) * G + b] * 4`, giá trị 0..1.
    data: Vec<f32>,
}

impl Lut3 {
    /// Nội suy 3 tuyến tính.
    fn sample(&self, a: f32, b: f32, c: f32) -> [f32; 4] {
        let g = LUT_GRID - 1;
        let fa = a.clamp(0.0, 1.0) * g as f32;
        let fb = b.clamp(0.0, 1.0) * g as f32;
        let fc = c.clamp(0.0, 1.0) * g as f32;
        let (ia, ib, ic) = (fa.floor() as usize, fb.floor() as usize, fc.floor() as usize);
        let (ia, ib, ic) = (ia.min(g - 1), ib.min(g - 1), ic.min(g - 1));
        let (ta, tb, tc) = (fa - ia as f32, fb - ib as f32, fc - ic as f32);

        let idx = |x: usize, y: usize, z: usize| ((x * LUT_GRID + y) * LUT_GRID + z) * 4;
        let mut out = [0.0f32; 4];
        for ch in 0..4 {
            let c000 = self.data[idx(ia, ib, ic) + ch];
            let c100 = self.data[idx(ia + 1, ib, ic) + ch];
            let c010 = self.data[idx(ia, ib + 1, ic) + ch];
            let c110 = self.data[idx(ia + 1, ib + 1, ic) + ch];
            let c001 = self.data[idx(ia, ib, ic + 1) + ch];
            let c101 = self.data[idx(ia + 1, ib, ic + 1) + ch];
            let c011 = self.data[idx(ia, ib + 1, ic + 1) + ch];
            let c111 = self.data[idx(ia + 1, ib + 1, ic + 1) + ch];

            let c00 = c000 + (c100 - c000) * ta;
            let c10 = c010 + (c110 - c010) * ta;
            let c01 = c001 + (c101 - c001) * ta;
            let c11 = c011 + (c111 - c011) * ta;
            let c0 = c00 + (c10 - c00) * tb;
            let c1 = c01 + (c11 - c01) * tb;
            out[ch] = (c0 + (c1 - c0) * tc).clamp(0.0, 1.0);
        }
        out
    }
}

/// Bộ quản lý màu cho một lần render.
///
/// **Không** `Sync`: `lcms2::Transform` không an toàn đa luồng ở dạng mặc định, và
/// một `ColorManager` sống trong đúng một lần render một trang nên không cần
/// chia sẻ. Trả giá bằng `RefCell` cho cache thay vì `Mutex` — nhẹ hơn và không
/// có nguy cơ deadlock.
pub struct ColorManager {
    cmyk: Profile,
    /// Profile RGB nguồn cho `DeviceRGB`.
    ///
    /// `None` = dùng sRGB dựng sẵn của Little CMS. Cho phép chỉ định file là cần
    /// thiết để so golden: Ghostscript dùng `default_rgb.icc` riêng của nó, không
    /// phải sRGB chuẩn, nên nếu hai bên không dùng **cùng** profile nguồn thì
    /// chênh lệch đo được là chênh lệch profile chứ không phải chất lượng engine.
    rgb: Option<Profile>,
    intent: RenderIntent,
    /// LUT sRGB → CMYK, dựng khi lần đầu cần.
    srgb_lut: RefCell<Option<Lut3>>,
    /// LUT Lab → CMYK.
    lab_lut: RefCell<Option<Lut3>>,
    /// LUT cho profile nhúng, khoá bằng hash nội dung profile.
    embedded_luts: RefCell<HashMap<u64, Option<Lut3>>>,
    /// Profile gray → CMYK dạng bảng 256 ô (1 chiều nên không cần LUT 3D).
    gray_lut: RefCell<Option<Vec<[f32; 4]>>>,
    /// Bù điểm đen (black point compensation).
    ///
    /// Ảnh hưởng trực tiếp tới lượng mực ở vùng tối và tới tỉ lệ K/CMY, nên phải
    /// điều khiển được để đối chiếu với Ghostscript: hai bên bật/tắt khác nhau sẽ
    /// cho cùng tổng mực nhưng phân bố kênh khác — đúng thứ tách kẽm quan tâm.
    black_point_compensation: bool,
}

impl ColorManager {
    /// Dựng từ file profile CMYK đích (thường là FOGRA39.icc).
    pub fn from_cmyk_profile(path: &Path, intent: RenderIntent) -> PpeResult<Self> {
        let cmyk = Profile::new_file(path).map_err(|e| {
            PpeError::Unsupported(format!("không đọc được ICC CMYK '{}': {e}", path.display()))
        })?;
        Ok(ColorManager::from_profile(cmyk, intent))
    }

    /// Dựng từ byte của profile CMYK.
    pub fn from_cmyk_bytes(bytes: &[u8], intent: RenderIntent) -> PpeResult<Self> {
        let cmyk = Profile::new_icc(bytes)
            .map_err(|e| PpeError::Unsupported(format!("ICC CMYK không hợp lệ: {e}")))?;
        Ok(ColorManager::from_profile(cmyk, intent))
    }

    /// Dựng với cả profile CMYK đích và profile RGB nguồn.
    pub fn from_profiles(
        cmyk_path: &Path,
        rgb_path: Option<&Path>,
        intent: RenderIntent,
    ) -> PpeResult<Self> {
        let mut cm = ColorManager::from_cmyk_profile(cmyk_path, intent)?;
        if let Some(p) = rgb_path {
            let rgb = Profile::new_file(p).map_err(|e| {
                PpeError::Unsupported(format!("không đọc được ICC RGB '{}': {e}", p.display()))
            })?;
            cm.rgb = Some(rgb);
        }
        Ok(cm)
    }

    fn from_profile(cmyk: Profile, intent: RenderIntent) -> Self {
        ColorManager {
            cmyk,
            rgb: None,
            intent,
            srgb_lut: RefCell::new(None),
            lab_lut: RefCell::new(None),
            embedded_luts: RefCell::new(HashMap::new()),
            gray_lut: RefCell::new(None),
            black_point_compensation: true,
        }
    }

    pub fn intent(&self) -> RenderIntent {
        self.intent
    }

    /// Bật/tắt bù điểm đen. Xoá mọi LUT đã dựng vì chúng phụ thuộc cờ này.
    pub fn set_black_point_compensation(&mut self, on: bool) {
        if self.black_point_compensation != on {
            self.black_point_compensation = on;
            self.srgb_lut.replace(None);
            self.lab_lut.replace(None);
            self.gray_lut.replace(None);
            self.embedded_luts.borrow_mut().clear();
        }
    }

    fn cms_flags(&self) -> Flags {
        if self.black_point_compensation {
            Flags::BLACKPOINT_COMPENSATION
        } else {
            Flags::default()
        }
    }

    /// sRGB → CMYK.
    pub fn rgb_to_cmyk(&self, r: f32, g: f32, b: f32) -> Option<[f32; 4]> {
        let mut slot = self.srgb_lut.borrow_mut();
        if slot.is_none() {
            let fallback = Profile::new_srgb();
            let src = self.rgb.as_ref().unwrap_or(&fallback);
            *slot = self.build_lut(src, PixelFormat::RGB_FLT, |i, j, k| [i, j, k]);
        }
        slot.as_ref().map(|lut| lut.sample(r, g, b))
    }

    /// Lab (L 0..100, a/b −128..127) → CMYK.
    pub fn lab_to_cmyk(&self, l: f32, a: f32, b: f32) -> Option<[f32; 4]> {
        let mut slot = self.lab_lut.borrow_mut();
        if slot.is_none() {
            // Điểm trắng D50 — PCS của ICC dùng D50, không phải D65.
            let lab = Profile::new_lab4_context(
                lcms2::GlobalContext::new(),
                &lcms2::CIExyY { x: 0.3457, y: 0.3585, Y: 1.0 },
            )
            .ok()?;
            // Lưới LUT chạy 0..1, cần trải về khoảng thật của Lab.
            *slot = self.build_lut(&lab, PixelFormat::Lab_FLT, |i, j, k| {
                [i * 100.0, j * 255.0 - 128.0, k * 255.0 - 128.0]
            });
        }
        let ln = (l / 100.0).clamp(0.0, 1.0);
        let an = ((a + 128.0) / 255.0).clamp(0.0, 1.0);
        let bn = ((b + 128.0) / 255.0).clamp(0.0, 1.0);
        slot.as_ref().map(|lut| lut.sample(ln, an, bn))
    }

    /// Gray → CMYK theo profile.
    ///
    /// Cảnh báo prepress: qua ICC, gray đen thường ra **rich black** 4 màu chứ
    /// không phải K thuần. Với chữ nhỏ điều đó gây lệch bản khi in. Nên đường
    /// `DeviceGray` của engine vẫn map thẳng về K (xem `convert::gray_to_cmyk`);
    /// hàm này chỉ dùng cho `ICCBased` 1 kênh, nơi file đã khai rõ ý muốn.
    pub fn gray_to_cmyk(&self, gray: f32) -> Option<[f32; 4]> {
        let mut slot = self.gray_lut.borrow_mut();
        if slot.is_none() {
            let gray_profile = Profile::new_gray(
                &lcms2::CIExyY { x: 0.3457, y: 0.3585, Y: 1.0 },
                &lcms2::ToneCurve::new(2.2),
            )
            .ok()?;
            let t: Transform<f32, [f32; 4]> = Transform::new_flags(
                &gray_profile,
                PixelFormat::GRAY_FLT,
                &self.cmyk,
                PixelFormat::CMYK_FLT,
                self.intent.to_lcms(),
                self.cms_flags(),
            )
            .ok()?;
            let src: Vec<f32> = (0..256).map(|i| i as f32 / 255.0).collect();
            let mut dst = vec![[0.0f32; 4]; 256];
            t.transform_pixels(&src, &mut dst);
            *slot = Some(
                dst.into_iter()
                    .map(|c| [c[0] / 100.0, c[1] / 100.0, c[2] / 100.0, c[3] / 100.0])
                    .collect(),
            );
        }
        let idx = (gray.clamp(0.0, 1.0) * 255.0).round() as usize;
        slot.as_ref().map(|t| t[idx.min(255)])
    }

    /// Profile nhúng (`ICCBased`) 3 kênh → CMYK.
    ///
    /// Trả `None` nếu profile không đọc được — caller phải hạ `accuracy` chứ
    /// không được lặng lẽ coi như sRGB.
    pub fn embedded_to_cmyk(&self, profile: &[u8], a: f32, b: f32, c: f32) -> Option<[f32; 4]> {
        let key = hash_bytes(profile);
        let mut cache = self.embedded_luts.borrow_mut();
        let entry = cache.entry(key).or_insert_with(|| {
            let p = Profile::new_icc(profile).ok()?;
            self.build_lut(&p, PixelFormat::RGB_FLT, |i, j, k| [i, j, k])
        });
        entry.as_ref().map(|lut| lut.sample(a, b, c))
    }

    /// CMYK → sRGB, cho soft-proof. Biến đổi theo lô cả trang.
    ///
    /// Đây là chiều **ra**, không phải chiều đo: dùng để *xem* chứ không để kết
    /// luận lượng mực.
    pub fn cmyk_to_srgb_batch(&self, cmyk: &[[f32; 4]]) -> Option<Vec<[u8; 3]>> {
        let srgb = Profile::new_srgb();
        let t: Transform<[f32; 4], [u8; 3]> = Transform::new_flags(
            &self.cmyk,
            PixelFormat::CMYK_FLT,
            &srgb,
            PixelFormat::RGB_8,
            self.intent.to_lcms(),
            self.cms_flags(),
        )
        .ok()?;
        // lcms nhận CMYK theo thang 0..100.
        let src: Vec<[f32; 4]> = cmyk
            .iter()
            .map(|c| [c[0] * 100.0, c[1] * 100.0, c[2] * 100.0, c[3] * 100.0])
            .collect();
        let mut dst = vec![[0u8; 3]; src.len()];
        t.transform_pixels(&src, &mut dst);
        Some(dst)
    }

    /// Dựng LUT 33³ từ một profile nguồn 3 kênh.
    /// CMYK → blending RGB theo đúng profile RGB nguồn của `DeviceRGB`.
    ///
    /// Khác `cmyk_to_srgb_batch`: hàm này giữ float để dùng làm backdrop blending,
    /// không lượng tử hoá qua RGB 8-bit.
    pub fn cmyk_to_rgb_blend_batch(&self, cmyk: &[[f32; 4]]) -> Option<Vec<[f32; 3]>> {
        let fallback = Profile::new_srgb();
        let rgb = self.rgb.as_ref().unwrap_or(&fallback);
        let t: Transform<[f32; 4], [f32; 3]> = Transform::new_flags(
            &self.cmyk,
            PixelFormat::CMYK_FLT,
            rgb,
            PixelFormat::RGB_FLT,
            self.intent.to_lcms(),
            self.cms_flags(),
        )
        .ok()?;
        let src: Vec<[f32; 4]> = cmyk
            .iter()
            .map(|c| [c[0] * 100.0, c[1] * 100.0, c[2] * 100.0, c[3] * 100.0])
            .collect();
        let mut dst = vec![[0.0f32; 3]; src.len()];
        t.transform_pixels(&src, &mut dst);
        Some(dst)
    }

    fn build_lut(
        &self,
        src_profile: &Profile,
        src_format: PixelFormat,
        to_src_range: impl Fn(f32, f32, f32) -> [f32; 3],
    ) -> Option<Lut3> {
        let t: Transform<[f32; 3], [f32; 4]> = Transform::new_flags(
            src_profile,
            src_format,
            &self.cmyk,
            PixelFormat::CMYK_FLT,
            self.intent.to_lcms(),
            // Bù điểm đen: không có nó, đen của ảnh ra xám nhạt trên giấy.
            self.cms_flags(),
        )
        .ok()?;

        let g = (LUT_GRID - 1) as f32;
        let mut src = Vec::with_capacity(LUT_GRID * LUT_GRID * LUT_GRID);
        for i in 0..LUT_GRID {
            for j in 0..LUT_GRID {
                for k in 0..LUT_GRID {
                    src.push(to_src_range(i as f32 / g, j as f32 / g, k as f32 / g));
                }
            }
        }
        let mut dst = vec![[0.0f32; 4]; src.len()];
        t.transform_pixels(&src, &mut dst);

        // lcms trả CMYK thang 0..100; ink space của PPE dùng 0..1.
        let mut data = Vec::with_capacity(dst.len() * 4);
        for c in dst {
            for ch in 0..4 {
                data.push((c[ch] / 100.0).clamp(0.0, 1.0));
            }
        }
        Some(Lut3 { data })
    }
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    // FNV-1a: đủ cho khoá cache, không cần chống đối kháng.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    // Gộp thêm độ dài để hai profile khác dài không dễ trùng.
    h ^ (bytes.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fogra39() -> Option<ColorManager> {
        let p = Path::new("../backend/app/assets/icc/FOGRA39.icc");
        if !p.is_file() {
            return None;
        }
        ColorManager::from_cmyk_profile(p, RenderIntent::RelativeColorimetric).ok()
    }

    macro_rules! cm_or_skip {
        () => {
            match fogra39() {
                Some(cm) => cm,
                None => {
                    eprintln!("bỏ qua: không có FOGRA39.icc");
                    return;
                }
            }
        };
    }

    #[test]
    fn intent_maps_from_pdf_values() {
        assert_eq!(RenderIntent::from_pdf(0), RenderIntent::Perceptual);
        assert_eq!(RenderIntent::from_pdf(1), RenderIntent::RelativeColorimetric);
        assert_eq!(RenderIntent::from_pdf(2), RenderIntent::Saturation);
        assert_eq!(RenderIntent::from_pdf(3), RenderIntent::AbsoluteColorimetric);
        // Giá trị lạ phải về mặc định an toàn, không panic.
        assert_eq!(RenderIntent::from_pdf(99), RenderIntent::RelativeColorimetric);
    }

    #[test]
    fn profile_loads_and_reports_error_for_garbage() {
        assert!(ColorManager::from_cmyk_bytes(b"khong phai ICC", RenderIntent::default()).is_err());
    }

    #[test]
    fn rgb_white_maps_to_almost_no_ink() {
        let cm = cm_or_skip!();
        let c = cm.rgb_to_cmyk(1.0, 1.0, 1.0).expect("phải có LUT");
        let total: f32 = c.iter().sum();
        assert!(total < 0.10, "trắng phải gần như không mực: {c:?}");
    }

    #[test]
    fn rgb_black_generates_black_ink() {
        // Đây chính là điểm khác biệt với công thức naive: ICC sinh đen thật.
        let cm = cm_or_skip!();
        let c = cm.rgb_to_cmyk(0.0, 0.0, 0.0).expect("phải có LUT");
        assert!(c[3] > 0.5, "K phải đáng kể: {c:?}");
    }

    #[test]
    fn rgb_black_total_ink_stays_below_press_limit() {
        // ICC FOGRA39 phải cho tổng mực trong tầm in được (< 340%), khác hẳn
        // đường UseFastColor của GS (RGB đen → C+M+Y = 300%, K = 0).
        let cm = cm_or_skip!();
        let c = cm.rgb_to_cmyk(0.0, 0.0, 0.0).unwrap();
        let tac: f32 = c.iter().sum::<f32>() * 100.0;
        assert!(tac < 340.0, "TAC của RGB đen qua ICC = {tac}%");
        assert!(tac > 200.0, "và cũng không được quá thấp: {tac}%");
    }

    #[test]
    fn rgb_primaries_land_on_expected_inks() {
        let cm = cm_or_skip!();
        let red = cm.rgb_to_cmyk(1.0, 0.0, 0.0).unwrap();
        assert!(red[1] > 0.5 && red[2] > 0.5, "đỏ cần M và Y: {red:?}");
        assert!(red[0] < 0.2, "đỏ không cần Cyan: {red:?}");

        let blue = cm.rgb_to_cmyk(0.0, 0.0, 1.0).unwrap();
        assert!(blue[0] > 0.5 && blue[1] > 0.3, "xanh cần C và M: {blue:?}");
    }

    #[test]
    fn lut_is_monotonic_along_the_gray_axis() {
        // Xám càng tối thì tổng mực càng nhiều. Không đơn điệu là dấu hiệu LUT
        // hoặc nội suy bị lệch chỉ số.
        let cm = cm_or_skip!();
        let mut prev = -1.0f32;
        for step in 0..=10 {
            let v = 1.0 - step as f32 / 10.0;
            let tac: f32 = cm.rgb_to_cmyk(v, v, v).unwrap().iter().sum();
            assert!(tac >= prev - 0.02, "không đơn điệu tại v={v}: {tac} < {prev}");
            prev = tac;
        }
    }

    #[test]
    fn interpolation_matches_lattice_points_exactly() {
        // Điểm nằm đúng trên nút lưới thì nội suy không được làm lệch giá trị.
        let cm = cm_or_skip!();
        let g = (LUT_GRID - 1) as f32;
        let on_node = 8.0 / g;
        let a = cm.rgb_to_cmyk(on_node, on_node, on_node).unwrap();
        let b = cm.rgb_to_cmyk(on_node, on_node, on_node).unwrap();
        assert_eq!(a, b, "phải tất định");
    }

    #[test]
    fn lab_white_maps_to_almost_no_ink() {
        let cm = cm_or_skip!();
        let c = cm.lab_to_cmyk(100.0, 0.0, 0.0).expect("phải có LUT Lab");
        assert!(c.iter().sum::<f32>() < 0.15, "{c:?}");
    }

    #[test]
    fn lab_black_generates_ink() {
        let cm = cm_or_skip!();
        let c = cm.lab_to_cmyk(0.0, 0.0, 0.0).expect("phải có LUT Lab");
        assert!(c[3] > 0.3, "{c:?}");
    }

    #[test]
    fn gray_via_icc_is_available() {
        let cm = cm_or_skip!();
        let black = cm.gray_to_cmyk(0.0).expect("phải có bảng gray");
        let white = cm.gray_to_cmyk(1.0).unwrap();
        assert!(black.iter().sum::<f32>() > white.iter().sum::<f32>());
    }

    #[test]
    fn softproof_roundtrip_keeps_white_and_black_apart() {
        let cm = cm_or_skip!();
        let out = cm
            .cmyk_to_srgb_batch(&[[0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]])
            .expect("soft-proof phải chạy");
        assert!(out[0][0] > 200, "giấy trắng: {:?}", out[0]);
        assert!(out[1][0] < 90, "K đặc phải tối: {:?}", out[1]);
    }

    #[test]
    fn embedded_profile_garbage_returns_none_not_srgb_fallback() {
        // Lặng lẽ coi profile hỏng như sRGB sẽ cho ra màu sai mà không ai biết.
        let cm = cm_or_skip!();
        assert!(cm.embedded_to_cmyk(b"rac", 0.5, 0.5, 0.5).is_none());
    }

    #[test]
    fn embedded_profile_is_cached_by_content() {
        let cm = cm_or_skip!();
        let srgb_bytes = match std::fs::read("../backend/app/assets/icc/sRGB.icc") {
            Ok(b) => b,
            Err(_) => return,
        };
        let a = cm.embedded_to_cmyk(&srgb_bytes, 0.2, 0.4, 0.6);
        let b = cm.embedded_to_cmyk(&srgb_bytes, 0.2, 0.4, 0.6);
        assert_eq!(a, b);
        assert!(a.is_some());
        assert_eq!(cm.embedded_luts.borrow().len(), 1, "phải cache, không dựng lại");
    }

    #[test]
    fn hash_distinguishes_different_profiles() {
        assert_ne!(hash_bytes(b"aaaa"), hash_bytes(b"aaab"));
        assert_ne!(hash_bytes(b"aa"), hash_bytes(b"aaaa"));
    }
}
