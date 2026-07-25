//! Quy đổi màu về không gian mực khi **không** có ICC.
//!
//! # Cảnh báo về độ tin cậy
//!
//! Các công thức trong file này là **fallback**, không phải color management.
//! Chúng chỉ đúng cho hai việc:
//!
//! * đo **lượng mực** (TAC) khi nguồn đã là DeviceCMYK — trường hợp này không có
//!   quy đổi nào cả, chỉ copy;
//! * xem trước nhanh khi thiếu ICC profile, và khi đó kết quả **phải** bị gắn
//!   `accuracy = approximate` ở lớp trên.
//!
//! Chuyển RGB→CMYK đúng đắn cần ICC (FOGRA39 + rendering intent + black
//! generation). Việc đó do module ICC đảm nhiệm, không phải ở đây. Sự tồn tại
//! của file này chính là chỗ mà `separations.py` cũ đã sai: nó dùng công thức
//! naive rồi trình bày như kẽm thật.

/// DeviceGray → mực.
///
/// Gray 1.0 = trắng, 0.0 = đen. Đen của DeviceGray quy về **K thuần**, không
/// phải rich black — đây là hành vi xưởng mong đợi và là lý do pre-pass
/// `preserve_black` tồn tại ở lớp Python.
pub fn gray_to_cmyk(gray: f32) -> [f32; 4] {
    let k = (1.0 - gray).clamp(0.0, 1.0);
    [0.0, 0.0, 0.0, k]
}

/// DeviceRGB → CMYK bằng UCR đơn giản (không ICC).
///
/// Chỉ dùng khi không có profile. Kết quả lệch RIP rõ rệt ở màu bù và da người.
pub fn rgb_to_cmyk_naive(r: f32, g: f32, b: f32) -> [f32; 4] {
    let r = r.clamp(0.0, 1.0);
    let g = g.clamp(0.0, 1.0);
    let b = b.clamp(0.0, 1.0);
    let k = 1.0 - r.max(g).max(b);
    if k >= 1.0 {
        return [0.0, 0.0, 0.0, 1.0];
    }
    let inv = 1.0 - k;
    [
        (1.0 - r - k) / inv,
        (1.0 - g - k) / inv,
        (1.0 - b - k) / inv,
        k,
    ]
}

/// CIE L\*a\*b\* → sRGB tuyến tính rồi → CMYK naive.
///
/// Lab xuất hiện trong `Lab` colorspace và trong ICC-based fallback. Đường này
/// luôn là xấp xỉ; đánh dấu approximate ở lớp gọi.
pub fn lab_to_cmyk_naive(l: f32, a: f32, b: f32) -> [f32; 4] {
    let (r, g, bl) = lab_to_srgb(l, a, b);
    rgb_to_cmyk_naive(r, g, bl)
}

/// Lab (D50) → sRGB 0..1.
pub fn lab_to_srgb(l: f32, a: f32, b: f32) -> (f32, f32, f32) {
    // Lab → XYZ (trắng chuẩn D50, khớp PCS của ICC).
    const XN: f32 = 0.9642;
    const YN: f32 = 1.0;
    const ZN: f32 = 0.8249;

    let fy = (l + 16.0) / 116.0;
    let fx = fy + a / 500.0;
    let fz = fy - b / 200.0;

    let finv = |t: f32| -> f32 {
        const DELTA: f32 = 6.0 / 29.0;
        if t > DELTA {
            t * t * t
        } else {
            3.0 * DELTA * DELTA * (t - 4.0 / 29.0)
        }
    };

    let x = XN * finv(fx);
    let y = YN * finv(fy);
    let z = ZN * finv(fz);

    // XYZ(D50) → sRGB tuyến tính (Bradford-adapted).
    let rl = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
    let gl = -0.9787684 * x + 1.9161415 * y + 0.0334540 * z;
    let bl = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;

    (gamma_srgb(rl), gamma_srgb(gl), gamma_srgb(bl))
}

fn gamma_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn gray_black_becomes_k_only() {
        // Rich black từ DeviceGray là lỗi in kinh điển (chữ nhỏ 4 màu bị lệch bản).
        let c = gray_to_cmyk(0.0);
        assert_eq!(c, [0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn gray_white_has_no_ink() {
        assert_eq!(gray_to_cmyk(1.0), [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn rgb_black_becomes_k_only() {
        assert_eq!(rgb_to_cmyk_naive(0.0, 0.0, 0.0), [0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn rgb_white_has_no_ink() {
        assert_eq!(rgb_to_cmyk_naive(1.0, 1.0, 1.0), [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn rgb_pure_red_maps_to_m_and_y() {
        let c = rgb_to_cmyk_naive(1.0, 0.0, 0.0);
        assert!(approx(c[0], 0.0));
        assert!(approx(c[1], 1.0));
        assert!(approx(c[2], 1.0));
        assert!(approx(c[3], 0.0));
    }

    #[test]
    fn lab_white_is_near_paper() {
        let c = lab_to_cmyk_naive(100.0, 0.0, 0.0);
        assert!(c.iter().all(|v| *v < 0.05), "{c:?}");
    }

    #[test]
    fn lab_black_is_near_full_k() {
        let c = lab_to_cmyk_naive(0.0, 0.0, 0.0);
        assert!(c[3] > 0.95, "{c:?}");
    }

    #[test]
    fn naive_conversion_output_stays_in_gamut_bounds() {
        for r in 0..=4 {
            for g in 0..=4 {
                for b in 0..=4 {
                    let c = rgb_to_cmyk_naive(r as f32 / 4.0, g as f32 / 4.0, b as f32 / 4.0);
                    assert!(c.iter().all(|v| (0.0..=1.0).contains(v)), "{c:?}");
                }
            }
        }
    }
}
