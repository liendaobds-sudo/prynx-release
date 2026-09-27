// PPE Viewer GPU - Color Resolve WGSL Shader (Milestone G2.1)
//
// Chuyen doi tu intermediate texture (Rgba16Float chua CMYK hoac RGB)
// sang surface hiển thị. Nhánh CMYK chỉ là swatch xấp xỉ, không có ICC/overprint.
// PERF (audit 2026-09-25 §R25.GPU.07): surface sRGB tự encode khi store.
override TARGET_SRGB: bool = false;

fn display_pixel(rgb: vec3<f32>) -> vec4<f32> {
    let srgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    if TARGET_SRGB {
        let linear = select(pow((srgb + 0.055) / 1.055, vec3<f32>(2.4)), srgb / 12.92, srgb <= vec3<f32>(0.04045));
        return vec4<f32>(linear, 1.0);
    }
    return vec4<f32>(srgb, 1.0);
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    // Fullscreen quad tu 3 dinh (Fullscreen Triangle ky thuat chuan)
    let x = f32(i32(in_vertex_index == 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index == 2u) * 4 - 1);
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

struct ResolveUniforms {
    proof_mode: u32,       // 1 = CMYK Proof mode, 0 = Direct pass
    overprint_sim: u32,    // 1 = Active, 0 = Inactive
    gamma: f32,            // 2.2 mac dinh
    brightness: f32,       // 1.0 mac dinh
};

@group(0) @binding(0)
var t_input: texture_2d<f32>;

@group(0) @binding(1)
var s_input: sampler;

@group(0) @binding(2)
var<uniform> uniforms: ResolveUniforms;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let ink = textureSample(t_input, s_input, in.uv);

    if (uniforms.proof_mode == 1u) {
        // Quy uoc Intermediate Rgba16Float:
        // ink.r = Cyan, ink.g = Magenta, ink.b = Yellow, ink.a = Black
        let c = clamp(ink.r, 0.0, 1.0);
        let m = clamp(ink.g, 0.0, 1.0);
        let y = clamp(ink.b, 0.0, 1.0);
        let k = clamp(ink.a, 0.0, 1.0);

        // Chuyen doi tru muc (Subtractive CMYK -> Display sRGB)
        let r = (1.0 - c) * (1.0 - k);
        let g = (1.0 - m) * (1.0 - k);
        let b = (1.0 - y) * (1.0 - k);

        return display_pixel(vec3<f32>(r, g, b) * uniforms.brightness);
    } else {
        // Direct RGB passthrough
        return display_pixel(ink.rgb * uniforms.brightness);
    }
}
