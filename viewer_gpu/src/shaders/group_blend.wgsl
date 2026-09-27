// PPE Viewer GPU - Transparency Group Compositing & Blend WGSL Shader (Milestone G2.3)
// ISO 32000-2 Clause 11 (Transparency & Blending)

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    // Procedural Fullscreen Triangle: 3 vertices phủ kín toàn bộ viewport
    let x = f32(i32(in_vertex_index == 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index == 2u) * 4 - 1);
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

struct GroupBlendUniforms {
    blend_mode: u32,       // 0: Normal, 1: Multiply, 2: Screen, 3: Overlay, 4: Darken, 5: Lighten,
                           // 6: ColorDodge, 7: ColorBurn, 8: HardLight, 9: SoftLight, 10: Difference, 11: Exclusion
    isolated: u32,         // 1: Isolated group, 0: Non-isolated group
    has_mask: u32,         // 1: Có soft mask, 0: Không mask
    mask_type: u32,        // 0: Alpha, 1: Luminosity
    group_alpha: f32,      // Alpha hằng của nhóm (0.0 .. 1.0)
    color_space: u32,      // 0: Subtractive CMYK, 1: Additive RGB
    invert_mask: u32,      // 1: Đảo ngược mask (1.0 - M)
    _padding: f32,
}

@group(0) @binding(0) var backdrop_texture: texture_2d<f32>;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var mask_texture: texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: GroupBlendUniforms;

// Công thức hòa trộn cho 1 kênh trong không gian cộng (0.0 .. 1.0) theo ISO 32000-2 Table 134
fn blend_channel(cb: f32, cs: f32, mode: u32) -> f32 {
    switch mode {
        case 0u: { // Normal
            return cs;
        }
        case 1u: { // Multiply
            return cb * cs;
        }
        case 2u: { // Screen
            return cb + cs - cb * cs;
        }
        case 3u: { // Overlay = HardLight với 2 toán hạng đảo chỗ
            if cb <= 0.5 {
                return 2.0 * cb * cs;
            } else {
                return 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
            }
        }
        case 4u: { // Darken
            return min(cb, cs);
        }
        case 5u: { // Lighten
            return max(cb, cs);
        }
        case 6u: { // ColorDodge
            if cb <= 0.0 {
                return 0.0;
            } else if cs >= 1.0 {
                return 1.0;
            } else {
                return min(1.0, cb / (1.0 - cs));
            }
        }
        case 7u: { // ColorBurn
            if cb >= 1.0 {
                return 1.0;
            } else if cs <= 0.0 {
                return 0.0;
            } else {
                return 1.0 - min(1.0, (1.0 - cb) / cs);
            }
        }
        case 8u: { // HardLight
            if cs <= 0.5 {
                return 2.0 * cb * cs;
            } else {
                return 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
            }
        }
        case 9u: { // SoftLight
            if cs <= 0.5 {
                return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
            } else {
                var d: f32 = 0.0;
                if cb <= 0.25 {
                    d = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
                } else {
                    d = sqrt(max(cb, 0.0));
                }
                return cb + (2.0 * cs - 1.0) * (d - cb);
            }
        }
        case 10u: { // Difference
            return abs(cb - cs);
        }
        case 11u: { // Exclusion
            return cb + cs - 2.0 * cb * cs;
        }
        default: {
            return cs;
        }
    }
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let cb_raw = textureSample(backdrop_texture, tex_sampler, in.uv);
    let cs_raw = textureSample(source_texture, tex_sampler, in.uv);

    // Tính hệ số mask nếu có soft mask
    var mask_val = 1.0;
    if uniforms.has_mask == 1u {
        let m_samp = textureSample(mask_texture, tex_sampler, in.uv);
        // PERF (audit 2026-09-25 §R25.GPU.05): đầu vào là độ phủ đã resolve,
        // không còn là màu nguồn. Không chuyển CMYK/luminosity lần thứ hai.
        mask_val = clamp(m_samp.r, 0.0, 1.0);

        if uniforms.invert_mask == 1u {
            mask_val = 1.0 - mask_val;
        }
    }

    let eff_alpha = clamp(uniforms.group_alpha * mask_val, 0.0, 1.0);

    // Không gian CMYK trừ (Subtractive)
    if uniforms.color_space == 0u {
        if uniforms.isolated == 0u {
            // Non-isolated group: source đã chứa backdrop được vẽ bên trong nó.
            // Kết quả chỉ cần nội suy giữa backdrop gốc và group theo eff_alpha.
            return clamp(mix(cb_raw, cs_raw, eff_alpha), vec4<f32>(0.0), vec4<f32>(1.0));
        } else {
            // Isolated group: group được vẽ trên nền rỗng, bây giờ hòa trộn vào backdrop
            let cb = 1.0 - clamp(cb_raw, vec4<f32>(0.0), vec4<f32>(1.0));
            let cs = 1.0 - clamp(cs_raw, vec4<f32>(0.0), vec4<f32>(1.0));

            var blended_sub = vec4<f32>(0.0);
            blended_sub.r = 1.0 - blend_channel(cb.r, cs.r, uniforms.blend_mode);
            blended_sub.g = 1.0 - blend_channel(cb.g, cs.g, uniforms.blend_mode);
            blended_sub.b = 1.0 - blend_channel(cb.b, cs.b, uniforms.blend_mode);
            blended_sub.a = 1.0 - blend_channel(cb.a, cs.a, uniforms.blend_mode);

            let res = mix(cb_raw, blended_sub, eff_alpha);
            return clamp(res, vec4<f32>(0.0), vec4<f32>(1.0));
        }
    } else {
        // Không gian RGB cộng (Additive)
        if uniforms.isolated == 0u {
            return clamp(mix(cb_raw, cs_raw, eff_alpha), vec4<f32>(0.0), vec4<f32>(1.0));
        } else {
            var blended_rgb = vec3<f32>(0.0);
            blended_rgb.r = blend_channel(cb_raw.r, cs_raw.r, uniforms.blend_mode);
            blended_rgb.g = blend_channel(cb_raw.g, cs_raw.g, uniforms.blend_mode);
            blended_rgb.b = blend_channel(cb_raw.b, cs_raw.b, uniforms.blend_mode);

            let res_rgb = mix(cb_raw.rgb, blended_rgb, eff_alpha);
            let res_a = mix(cb_raw.a, cs_raw.a, eff_alpha);
            return vec4<f32>(clamp(res_rgb, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(res_a, 0.0, 1.0));
        }
    }
}
