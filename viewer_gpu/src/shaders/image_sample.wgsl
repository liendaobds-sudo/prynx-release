// PPE Viewer GPU - Image Sampling & Affine Mapping WGSL Shader (Milestone G2.4)
// ISO 32000-2 Clause 8.9 (Images) & Clause 11 (Image Masks)

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct ImageUniforms {
    transform_matrix: mat4x4<f32>, // offset 0..64
    tint_cmyk: vec4<f32>,          // offset 64..80 (16-byte aligned)
    color_type: u32,               // offset 80..84: 0 = CMYK, 1 = RGB, 2 = Image Mask
    has_alpha: u32,                // offset 84..88
    alpha: f32,                    // offset 88..92
    _padding: f32,                 // offset 92..96
}

@group(0) @binding(0) var image_texture: texture_2d<f32>;
@group(0) @binding(1) var image_sampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: ImageUniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = uniforms.transform_matrix * vec4<f32>(in.position, 0.0, 1.0);
    out.uv = in.uv;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let raw_sample = textureSample(image_texture, image_sampler, in.uv);

    if uniforms.color_type == 2u {
        // Image Mask: Raw sample dai dien cho do phu (coverage: 0.0 .. 1.0).
        // To mau bang uniforms.tint_cmyk va nhan voi do phu.
        let coverage = raw_sample.r * uniforms.alpha;
        return clamp(uniforms.tint_cmyk * coverage, vec4<f32>(0.0), vec4<f32>(1.0));
    } else if uniforms.color_type == 1u {
        // RGB Image: Chuyen doi Additive RGB sang Subtractive CMYK
        // R = 1 - C, G = 1 - M, B = 1 - Y (co the tach Black)
        let r = clamp(raw_sample.r, 0.0, 1.0);
        let g = clamp(raw_sample.g, 0.0, 1.0);
        let b = clamp(raw_sample.b, 0.0, 1.0);

        let k = min(1.0 - r, min(1.0 - g, 1.0 - b));
        var c = 0.0;
        var m = 0.0;
        var y = 0.0;
        if k < 1.0 {
            c = (1.0 - r - k) / (1.0 - k);
            m = (1.0 - g - k) / (1.0 - k);
            y = (1.0 - b - k) / (1.0 - k);
        } else {
            c = 0.0;
            m = 0.0;
            y = 0.0;
        }

        // PERF (audit 2026-09-25 §R25.GPU.06): alpha pixel RGB độc lập
        // với opacity đối tượng. Thành phần thứ tư của ảnh CMYK vẫn là K.
        let pixel_alpha = select(1.0, clamp(raw_sample.a, 0.0, 1.0), uniforms.has_alpha != 0u);
        let cmyk = vec4<f32>(c, m, y, k) * (uniforms.alpha * pixel_alpha);
        return clamp(cmyk, vec4<f32>(0.0), vec4<f32>(1.0));
    } else {
        // CMYK Image truc tiep: raw_sample da o he CMYK (R=C, G=M, B=Y, A=K)
        let cmyk = raw_sample * uniforms.alpha;
        return clamp(cmyk, vec4<f32>(0.0), vec4<f32>(1.0));
    }
}

// Độ phủ xuất riêng; group/CMYK không được diễn giải thành phần K là alpha.
@fragment
fn fs_coverage(in: VertexOutput) -> @location(0) vec4<f32> {
    let raw = textureSample(image_texture, image_sampler, in.uv);
    var coverage = uniforms.alpha;
    if uniforms.color_type == 2u { coverage *= raw.r; }
    else if uniforms.color_type == 1u && uniforms.has_alpha != 0u { coverage *= raw.a; }
    return vec4<f32>(clamp(coverage, 0.0, 1.0));
}
