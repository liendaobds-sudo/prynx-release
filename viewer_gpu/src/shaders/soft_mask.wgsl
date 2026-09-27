// PPE Viewer GPU - Soft Mask Generation WGSL Shader (Milestone G2.3)
// ISO 32000-2 §11.6.5 (Soft-Mask Dictionaries: /Luminosity & /Alpha)

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(in_vertex_index == 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index == 2u) * 4 - 1);
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

struct SoftMaskUniforms {
    mask_type: u32,       // 0: Alpha, 1: Luminosity
    color_space: u32,     // 0: CMYK, 1: RGB
    invert: u32,          // 1: Đảo ngược (1.0 - L)
    backdrop_lum: f32,    // Giá trị nền /BC sau chuyển đổi
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var tex_sampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: SoftMaskUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let src = textureSample(source_texture, tex_sampler, in.uv);
    var lum: f32 = 0.0;

    if uniforms.mask_type == 1u {
        // Luminosity Soft Mask: Y = 0.30 R + 0.59 G + 0.11 B
        if uniforms.color_space == 0u {
            // CMYK Subtractive -> RGB Additive
            let k = src.a;
            let r = (1.0 - src.r) * (1.0 - k);
            let g = (1.0 - src.g) * (1.0 - k);
            let b = (1.0 - src.b) * (1.0 - k);
            lum = clamp(0.30 * r + 0.59 * g + 0.11 * b, 0.0, 1.0);
        } else {
            // RGB Additive
            lum = clamp(0.30 * src.r + 0.59 * src.g + 0.11 * src.b, 0.0, 1.0);
        }
    } else {
        // PERF (audit 2026-09-25 §R25.GPU.04): scalar plane tách khỏi 4 kênh mực.
        lum = clamp(select(src.a, src.r, uniforms.color_space == 2u), 0.0, 1.0);
    }

    if uniforms.invert == 1u {
        lum = 1.0 - lum;
    }

    return vec4<f32>(lum, lum, lum, lum);
}
