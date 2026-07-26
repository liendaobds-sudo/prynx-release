//! Blend mode (ISO 32000-2 §11.3.5).
//!
//! # Điểm dễ sai nhất: không gian trừ
//!
//! Công thức blend của PDF được định nghĩa trên **giá trị cộng** (additive), nơi
//! `0` là tối và `1` là sáng. Ink space của PPE là **trừ** (subtractive): `0` là
//! không mực (giấy trắng), `1` là đầy mực.
//!
//! Spec §11.3.5.2 quy định: với không gian trừ, phải áp công thức lên **phần bù**
//! của các thành phần. Bỏ bước bù này làm `Multiply` hoá thành `Screen` và ngược
//! lại — bóng đổ biến thành vệt sáng. Đây là lỗi nhìn ra ngay trên màn hình nhưng
//! chỉ sau khi in mới biết đã tốn giấy.
//!
//! # Blend tách kênh và không tách kênh
//!
//! Mười một mode đầu là **tách kênh**: tính độc lập từng kênh mực, nên đúng tuyệt
//! đối cả với kẽm spot.
//!
//! Bốn mode cuối (`Hue`, `Saturation`, `Color`, `Luminosity`) **không** tách kênh:
//! chúng cần cả bộ ba màu. Trong không gian mực n kênh chúng không có định nghĩa
//! chính xác, nên PPE quy về xấp xỉ RGB và **báo là xấp xỉ** — không im lặng cho
//! ra một con số nghe hợp lý.

/// Blend mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

impl BlendMode {
    /// Đọc tên mode từ `/BM`.
    ///
    /// `/Compatible` là bí danh cũ của `/Normal` (§11.3.5). Tên lạ cũng về
    /// `Normal` theo spec, nhưng caller nên ghi nhận để biết file dùng gì.
    pub fn from_name(name: &str) -> Option<BlendMode> {
        Some(match name {
            "Normal" | "Compatible" => BlendMode::Normal,
            "Multiply" => BlendMode::Multiply,
            "Screen" => BlendMode::Screen,
            "Overlay" => BlendMode::Overlay,
            "Darken" => BlendMode::Darken,
            "Lighten" => BlendMode::Lighten,
            "ColorDodge" => BlendMode::ColorDodge,
            "ColorBurn" => BlendMode::ColorBurn,
            "HardLight" => BlendMode::HardLight,
            "SoftLight" => BlendMode::SoftLight,
            "Difference" => BlendMode::Difference,
            "Exclusion" => BlendMode::Exclusion,
            "Hue" => BlendMode::Hue,
            "Saturation" => BlendMode::Saturation,
            "Color" => BlendMode::Color,
            "Luminosity" => BlendMode::Luminosity,
            _ => return None,
        })
    }

    pub fn is_normal(self) -> bool {
        self == BlendMode::Normal
    }

    /// `true` nếu mode tính độc lập từng kênh.
    ///
    /// Chỉ mode tách kênh mới đúng tuyệt đối với kẽm spot; bốn mode còn lại phải
    /// đi qua xấp xỉ RGB.
    pub fn is_separable(self) -> bool {
        !matches!(
            self,
            BlendMode::Hue | BlendMode::Saturation | BlendMode::Color | BlendMode::Luminosity
        )
    }

    /// Trộn **một kênh mực**: nhận và trả lượng mực 0..1.
    ///
    /// Tự lo phần bù sang không gian cộng và bù lại, nên caller không có cơ hội
    /// quên bước đó.
    pub fn blend_ink(self, backdrop_ink: f32, source_ink: f32) -> f32 {
        if self == BlendMode::Normal {
            return source_ink;
        }
        // Không gian trừ → cộng.
        let cb = 1.0 - backdrop_ink.clamp(0.0, 1.0);
        let cs = 1.0 - source_ink.clamp(0.0, 1.0);
        let result = self.blend_additive(cb, cs);
        // Cộng → trừ.
        (1.0 - result).clamp(0.0, 1.0)
    }

    /// Trộn một pixel RGB trong không gian cộng của transparency group.
    ///
    /// Khác [`Self::blend_ink`], đường này không bù giá trị vì RGB đã là không
    /// gian cộng theo định nghĩa của PDF. Các mode không tách kênh phải xử lý cả
    /// bộ ba cùng lúc.
    pub fn blend_rgb(self, backdrop: [f32; 3], source: [f32; 3]) -> [f32; 3] {
        let cb = backdrop.map(|v| v.clamp(0.0, 1.0));
        let cs = source.map(|v| v.clamp(0.0, 1.0));
        if self.is_separable() {
            return [
                self.blend_additive(cb[0], cs[0]),
                self.blend_additive(cb[1], cs[1]),
                self.blend_additive(cb[2], cs[2]),
            ];
        }
        match self {
            BlendMode::Hue => set_lum(&set_sat(&cs, sat(&cb)), lum(&cb)),
            BlendMode::Saturation => set_lum(&set_sat(&cb, sat(&cs)), lum(&cb)),
            BlendMode::Color => set_lum(&cs, lum(&cb)),
            BlendMode::Luminosity => set_lum(&cb, lum(&cs)),
            _ => cs,
        }
    }

    /// Công thức trên giá trị cộng 0..1 (§11.3.5.2, Table 134).
    fn blend_additive(self, cb: f32, cs: f32) -> f32 {
        match self {
            BlendMode::Normal => cs,
            BlendMode::Multiply => cb * cs,
            BlendMode::Screen => cb + cs - cb * cs,
            // Overlay = HardLight với hai toán hạng đổi chỗ.
            BlendMode::Overlay => BlendMode::HardLight.blend_additive(cs, cb),
            BlendMode::Darken => cb.min(cs),
            BlendMode::Lighten => cb.max(cs),
            BlendMode::ColorDodge => {
                if cb <= 0.0 {
                    0.0
                } else if cs >= 1.0 {
                    1.0
                } else {
                    (cb / (1.0 - cs)).min(1.0)
                }
            }
            BlendMode::ColorBurn => {
                if cb >= 1.0 {
                    1.0
                } else if cs <= 0.0 {
                    0.0
                } else {
                    1.0 - ((1.0 - cb) / cs).min(1.0)
                }
            }
            BlendMode::HardLight => {
                if cs <= 0.5 {
                    BlendMode::Multiply.blend_additive(cb, 2.0 * cs)
                } else {
                    BlendMode::Screen.blend_additive(cb, 2.0 * cs - 1.0)
                }
            }
            BlendMode::SoftLight => {
                if cs <= 0.5 {
                    cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
                } else {
                    let d = if cb <= 0.25 {
                        ((16.0 * cb - 12.0) * cb + 4.0) * cb
                    } else {
                        cb.max(0.0).sqrt()
                    };
                    cb + (2.0 * cs - 1.0) * (d - cb)
                }
            }
            BlendMode::Difference => (cb - cs).abs(),
            BlendMode::Exclusion => cb + cs - 2.0 * cb * cs,
            // Không tách kênh: caller phải dùng `blend_nonseparable_cmyk`.
            BlendMode::Hue | BlendMode::Saturation | BlendMode::Color | BlendMode::Luminosity => cs,
        }
    }
}

/// Trộn bốn kênh process cho mode **không** tách kênh.
///
/// Quy CMYK về RGB xấp xỉ (`r = (1−c)(1−k)`), áp công thức không tách kênh của
/// spec, rồi quy về lại. Đây là **xấp xỉ có chủ ý**: định nghĩa chính xác cần
/// không gian trộn của group, mà với group CMYK thì spec cũng không cho công thức
/// đóng. Caller phải ghi nhận là xấp xỉ.
///
/// Kênh spot **không** bị chạm tới: mode không tách kênh không có nghĩa với mực
/// pha, và đoán ở đó sẽ làm sai kẽm spot — thứ dùng để chốt bản.
pub fn blend_nonseparable_cmyk(mode: BlendMode, backdrop: [f32; 4], source: [f32; 4]) -> [f32; 4] {
    let cb = cmyk_to_rgb(backdrop);
    let cs = cmyk_to_rgb(source);
    let out = match mode {
        BlendMode::Hue => set_lum(&set_sat(&cs, sat(&cb)), lum(&cb)),
        BlendMode::Saturation => set_lum(&set_sat(&cb, sat(&cs)), lum(&cb)),
        BlendMode::Color => set_lum(&cs, lum(&cb)),
        BlendMode::Luminosity => set_lum(&cb, lum(&cs)),
        _ => cs,
    };
    rgb_to_cmyk(out)
}

fn cmyk_to_rgb(cmyk: [f32; 4]) -> [f32; 3] {
    let k = cmyk[3].clamp(0.0, 1.0);
    [
        (1.0 - cmyk[0].clamp(0.0, 1.0)) * (1.0 - k),
        (1.0 - cmyk[1].clamp(0.0, 1.0)) * (1.0 - k),
        (1.0 - cmyk[2].clamp(0.0, 1.0)) * (1.0 - k),
    ]
}

fn rgb_to_cmyk(rgb: [f32; 3]) -> [f32; 4] {
    let r = rgb[0].clamp(0.0, 1.0);
    let g = rgb[1].clamp(0.0, 1.0);
    let b = rgb[2].clamp(0.0, 1.0);
    let k = 1.0 - r.max(g).max(b);
    if k >= 1.0 - f32::EPSILON {
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

// Các hàm phụ của mode không tách kênh — §11.3.5.3.

fn lum(c: &[f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn clip_color(mut c: [f32; 3]) -> [f32; 3] {
    let l = lum(&c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    if n < 0.0 {
        for v in c.iter_mut() {
            *v = l + (*v - l) * l / (l - n).max(f32::EPSILON);
        }
    }
    if x > 1.0 {
        for v in c.iter_mut() {
            *v = l + (*v - l) * (1.0 - l) / (x - l).max(f32::EPSILON);
        }
    }
    c
}

fn set_lum(c: &[f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

fn sat(c: &[f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn set_sat(c: &[f32; 3], s: f32) -> [f32; 3] {
    let max = c[0].max(c[1]).max(c[2]);
    let min = c[0].min(c[1]).min(c[2]);
    let mut out = [0.0f32; 3];
    if max > min {
        for i in 0..3 {
            out[i] = (c[i] - min) * s / (max - min);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn names_map_including_compatible_alias() {
        assert_eq!(BlendMode::from_name("Normal"), Some(BlendMode::Normal));
        assert_eq!(BlendMode::from_name("Compatible"), Some(BlendMode::Normal));
        assert_eq!(BlendMode::from_name("Multiply"), Some(BlendMode::Multiply));
        assert_eq!(BlendMode::from_name("KhongCo"), None);
    }

    #[test]
    fn separability_is_classified_correctly() {
        assert!(BlendMode::Multiply.is_separable());
        assert!(BlendMode::Exclusion.is_separable());
        assert!(!BlendMode::Hue.is_separable());
        assert!(!BlendMode::Luminosity.is_separable());
    }

    #[test]
    fn normal_returns_source_unchanged() {
        assert!(approx(BlendMode::Normal.blend_ink(0.3, 0.7), 0.7));
    }

    #[test]
    fn multiply_on_ink_darkens_meaning_more_ink() {
        // Đây là test chống lỗi thiếu bù không gian trừ. Multiply phải làm TỐI
        // hơn, tức là **nhiều mực hơn** cả nền lẫn nguồn.
        let r = BlendMode::Multiply.blend_ink(0.5, 0.5);
        assert!(r > 0.5, "Multiply phải tăng mực: {r}");
        // Kiểm bằng công thức: 1 - (0.5 * 0.5) = 0.75.
        assert!(approx(r, 0.75));
    }

    #[test]
    fn screen_on_ink_lightens_meaning_less_ink() {
        let r = BlendMode::Screen.blend_ink(0.5, 0.5);
        assert!(r < 0.5, "Screen phải giảm mực: {r}");
        assert!(approx(r, 0.25));
    }

    #[test]
    fn multiply_and_screen_are_not_swapped() {
        // Nếu quên bù không gian trừ, hai mode này đổi chỗ nhau — bóng đổ thành
        // vệt sáng. Chốt bằng bất đẳng thức thay vì chỉ bằng số.
        let m = BlendMode::Multiply.blend_ink(0.4, 0.6);
        let s = BlendMode::Screen.blend_ink(0.4, 0.6);
        assert!(m > s, "Multiply ({m}) phải nhiều mực hơn Screen ({s})");
    }

    #[test]
    fn multiply_with_no_ink_backdrop_keeps_source() {
        // Nền giấy trắng (0 mực) ⇒ Multiply cho ra đúng nguồn.
        assert!(approx(BlendMode::Multiply.blend_ink(0.0, 0.6), 0.6));
    }

    #[test]
    fn multiply_with_full_ink_backdrop_stays_full() {
        assert!(approx(BlendMode::Multiply.blend_ink(1.0, 0.3), 1.0));
    }

    #[test]
    fn darken_and_lighten_pick_more_and_less_ink() {
        // Trong ink space, "Darken" nghĩa là chọn bên NHIỀU mực hơn.
        assert!(approx(BlendMode::Darken.blend_ink(0.2, 0.8), 0.8));
        assert!(approx(BlendMode::Lighten.blend_ink(0.2, 0.8), 0.2));
    }

    #[test]
    fn difference_is_symmetric() {
        let a = BlendMode::Difference.blend_ink(0.3, 0.8);
        let b = BlendMode::Difference.blend_ink(0.8, 0.3);
        assert!(approx(a, b));
    }

    #[test]
    fn exclusion_with_half_and_half_is_neutral() {
        // cb=cs=0.5 (cộng) ⇒ 0.5+0.5-2*0.25 = 0.5 ⇒ mực 0.5.
        assert!(approx(BlendMode::Exclusion.blend_ink(0.5, 0.5), 0.5));
    }

    #[test]
    fn overlay_is_hardlight_with_operands_swapped() {
        let a = BlendMode::Overlay.blend_ink(0.3, 0.7);
        let b = BlendMode::HardLight.blend_ink(0.7, 0.3);
        assert!(approx(a, b), "a={a} b={b}");
    }

    #[test]
    fn colordodge_and_colorburn_stay_in_range() {
        for cb in [0.0, 0.25, 0.5, 0.75, 1.0] {
            for cs in [0.0, 0.25, 0.5, 0.75, 1.0] {
                for mode in [BlendMode::ColorDodge, BlendMode::ColorBurn] {
                    let r = mode.blend_ink(cb, cs);
                    assert!((0.0..=1.0).contains(&r) && r.is_finite(), "{mode:?} {cb} {cs} → {r}");
                }
            }
        }
    }

    #[test]
    fn softlight_stays_in_range_and_is_continuous_at_half() {
        let below = BlendMode::SoftLight.blend_ink(0.4, 1.0 - 0.4999);
        let above = BlendMode::SoftLight.blend_ink(0.4, 1.0 - 0.5001);
        assert!((below - above).abs() < 0.01, "phải liên tục: {below} vs {above}");
        for cb in [0.0, 0.3, 1.0] {
            for cs in [0.0, 0.5, 1.0] {
                let r = BlendMode::SoftLight.blend_ink(cb, cs);
                assert!((0.0..=1.0).contains(&r) && r.is_finite());
            }
        }
    }

    #[test]
    fn all_separable_modes_stay_in_range() {
        let modes = [
            BlendMode::Multiply,
            BlendMode::Screen,
            BlendMode::Overlay,
            BlendMode::Darken,
            BlendMode::Lighten,
            BlendMode::ColorDodge,
            BlendMode::ColorBurn,
            BlendMode::HardLight,
            BlendMode::SoftLight,
            BlendMode::Difference,
            BlendMode::Exclusion,
        ];
        for mode in modes {
            for i in 0..=10 {
                for j in 0..=10 {
                    let r = mode.blend_ink(i as f32 / 10.0, j as f32 / 10.0);
                    assert!(
                        (0.0..=1.0).contains(&r) && r.is_finite(),
                        "{mode:?} {i} {j} → {r}"
                    );
                }
            }
        }
    }

    #[test]
    fn luminosity_takes_lightness_from_source() {
        // Nền đen K, nguồn trắng ⇒ Luminosity phải làm sáng ra (ít mực).
        let out = blend_nonseparable_cmyk(
            BlendMode::Luminosity,
            [0.0, 0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0, 0.0],
        );
        assert!(out[3] < 0.5, "K phải giảm: {out:?}");
    }

    #[test]
    fn color_keeps_backdrop_lightness() {
        // Nền xám 50% K, nguồn đỏ đặc: `Color` giữ độ sáng nền.
        let out = blend_nonseparable_cmyk(
            BlendMode::Color,
            [0.0, 0.0, 0.0, 0.5],
            [0.0, 1.0, 1.0, 0.0],
        );
        assert!(out.iter().all(|v| (0.0..=1.0).contains(v)), "{out:?}");
    }

    #[test]
    fn nonseparable_output_stays_in_range() {
        let modes = [
            BlendMode::Hue,
            BlendMode::Saturation,
            BlendMode::Color,
            BlendMode::Luminosity,
        ];
        for mode in modes {
            for k in [0.0, 0.5, 1.0] {
                let out = blend_nonseparable_cmyk(mode, [0.2, 0.4, 0.6, k], [0.9, 0.1, 0.3, 0.2]);
                assert!(
                    out.iter().all(|v| (0.0..=1.0).contains(v) && v.is_finite()),
                    "{mode:?} k={k} → {out:?}"
                );
            }
        }
    }

    #[test]
    fn cmyk_rgb_roundtrip_is_stable_for_pure_inks() {
        for ink in [
            [0.0, 0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ] {
            let back = rgb_to_cmyk(cmyk_to_rgb(ink));
            for i in 0..4 {
                assert!((back[i] - ink[i]).abs() < 1e-3, "{ink:?} → {back:?}");
            }
        }
    }
}
