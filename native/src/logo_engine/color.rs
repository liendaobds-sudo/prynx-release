//! Chuyển đổi màu cảm nhận cho bước tiền xử lý Logo Engine v2.

#![allow(dead_code)]

use super::scene::SolidPaint;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct LabColor {
    pub(super) l: f64,
    pub(super) a: f64,
    pub(super) b: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PaletteColor {
    pub(super) paint: SolidPaint,
    lab: LabColor,
}

impl PaletteColor {
    fn from_rgb(rgb: [u8; 3]) -> Self {
        Self {
            paint: SolidPaint {
                rgba: [rgb[0], rgb[1], rgb[2], 255],
            },
            lab: rgb_to_lab(rgb),
        }
    }
}

pub(super) fn parse_palette(values: &[String]) -> Result<Vec<PaletteColor>, String> {
    values
        .iter()
        .map(|value| parse_hex_rgb(value).map(PaletteColor::from_rgb))
        .collect()
}

fn parse_hex_rgb(value: &str) -> Result<[u8; 3], String> {
    let hex = value
        .strip_prefix('#')
        .ok_or_else(|| "Màu palette phải có dạng #RRGGBB".to_string())?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Màu palette phải có dạng #RRGGBB".to_string());
    }
    let parse = |range| {
        u8::from_str_radix(&hex[range], 16)
            .map_err(|_| "Màu palette phải có dạng #RRGGBB".to_string())
    };
    Ok([parse(0..2)?, parse(2..4)?, parse(4..6)?])
}

pub(super) fn nearest_palette_index(rgb: [u8; 3], palette: &[PaletteColor]) -> usize {
    let sample = rgb_to_lab(rgb);
    palette
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            delta_e_2000(sample, left.lab).total_cmp(&delta_e_2000(sample, right.lab))
        })
        .map(|(index, _)| index)
        .unwrap_or(0)
}

pub(super) fn rgb_to_lab(rgb: [u8; 3]) -> LabColor {
    let linear = rgb.map(|channel| {
        let value = f64::from(channel) / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    });

    let x =
        (0.412_456_4 * linear[0] + 0.357_576_1 * linear[1] + 0.180_437_5 * linear[2]) / 0.950_47;
    let y = 0.212_672_9 * linear[0] + 0.715_152_2 * linear[1] + 0.072_175 * linear[2];
    let z = (0.019_333_9 * linear[0] + 0.119_192 * linear[1] + 0.950_304_1 * linear[2]) / 1.088_83;

    let convert = |value: f64| {
        const DELTA: f64 = 6.0 / 29.0;
        const DELTA_CUBED: f64 = DELTA * DELTA * DELTA;
        if value > DELTA_CUBED {
            value.cbrt()
        } else {
            value / (3.0 * DELTA * DELTA) + 4.0 / 29.0
        }
    };
    let fx = convert(x);
    let fy = convert(y);
    let fz = convert(z);

    LabColor {
        l: 116.0 * fy - 16.0,
        a: 500.0 * (fx - fy),
        b: 200.0 * (fy - fz),
    }
}

/// CIEDE2000 với trọng số chuẩn kL = kC = kH = 1.
pub(super) fn delta_e_2000(first: LabColor, second: LabColor) -> f64 {
    let c1 = first.a.hypot(first.b);
    let c2 = second.a.hypot(second.b);
    let c_bar = (c1 + c2) / 2.0;
    let c_bar_7 = c_bar.powi(7);
    let g = 0.5 * (1.0 - (c_bar_7 / (c_bar_7 + 25.0_f64.powi(7))).sqrt());

    let a1_prime = (1.0 + g) * first.a;
    let a2_prime = (1.0 + g) * second.a;
    let c1_prime = a1_prime.hypot(first.b);
    let c2_prime = a2_prime.hypot(second.b);
    let h1_prime = hue_degrees(first.b, a1_prime);
    let h2_prime = hue_degrees(second.b, a2_prime);

    let delta_l_prime = second.l - first.l;
    let delta_c_prime = c2_prime - c1_prime;
    let delta_h_angle = if c1_prime * c2_prime == 0.0 {
        0.0
    } else {
        let difference = h2_prime - h1_prime;
        if difference.abs() <= 180.0 {
            difference
        } else if difference > 180.0 {
            difference - 360.0
        } else {
            difference + 360.0
        }
    };
    let delta_h_prime =
        2.0 * (c1_prime * c2_prime).sqrt() * degrees_to_radians(delta_h_angle / 2.0).sin();

    let l_bar_prime = (first.l + second.l) / 2.0;
    let c_bar_prime = (c1_prime + c2_prime) / 2.0;
    let h_bar_prime = if c1_prime * c2_prime == 0.0 {
        h1_prime + h2_prime
    } else if (h1_prime - h2_prime).abs() <= 180.0 {
        (h1_prime + h2_prime) / 2.0
    } else if h1_prime + h2_prime < 360.0 {
        (h1_prime + h2_prime + 360.0) / 2.0
    } else {
        (h1_prime + h2_prime - 360.0) / 2.0
    };

    let t = 1.0 - 0.17 * degrees_to_radians(h_bar_prime - 30.0).cos()
        + 0.24 * degrees_to_radians(2.0 * h_bar_prime).cos()
        + 0.32 * degrees_to_radians(3.0 * h_bar_prime + 6.0).cos()
        - 0.20 * degrees_to_radians(4.0 * h_bar_prime - 63.0).cos();
    let delta_theta = 30.0 * (-((h_bar_prime - 275.0) / 25.0).powi(2)).exp();
    let c_bar_prime_7 = c_bar_prime.powi(7);
    let r_c = 2.0 * (c_bar_prime_7 / (c_bar_prime_7 + 25.0_f64.powi(7))).sqrt();
    let l_offset = l_bar_prime - 50.0;
    let s_l = 1.0 + 0.015 * l_offset * l_offset / (20.0 + l_offset * l_offset).sqrt();
    let s_c = 1.0 + 0.045 * c_bar_prime;
    let s_h = 1.0 + 0.015 * c_bar_prime * t;
    let r_t = -degrees_to_radians(2.0 * delta_theta).sin() * r_c;

    let l_term = delta_l_prime / s_l;
    let c_term = delta_c_prime / s_c;
    let h_term = delta_h_prime / s_h;
    (l_term * l_term + c_term * c_term + h_term * h_term + r_t * c_term * h_term).sqrt()
}

fn hue_degrees(b: f64, a_prime: f64) -> f64 {
    if a_prime == 0.0 && b == 0.0 {
        0.0
    } else {
        b.atan2(a_prime).to_degrees().rem_euclid(360.0)
    }
}

fn degrees_to_radians(value: f64) -> f64 {
    value * std::f64::consts::PI / 180.0
}
