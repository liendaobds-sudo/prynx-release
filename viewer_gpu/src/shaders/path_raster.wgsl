// PPE Viewer GPU - Vector Path Rasterizer WGSL Shader (Milestone G2.2)
//
// Rasterize vector primitives (triangles, rectangles, quadratic/cubic curves)
// truc tiep len intermediate texture Rgba16Float voi Anti-Aliasing (AA)
// va danh gia coverage analytical (Loop-Blinn / distance-to-edge).

struct PathUniforms {
    viewport_width: f32,
    viewport_height: f32,
    device_scale: f32,
    _pad: f32,
};

@group(0) @binding(0)
var<uniform> uniforms: PathUniforms;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) color: vec4<f32>, // CMYK ink [c, m, y, k]
    @location(3) flags: u32,       // bit 0: is_curve, bit 1: overprint
    @location(4) alpha: f32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) @interpolate(flat) flags: u32,
    @location(3) alpha: f32,
};

@vertex
fn vs_path(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    // Chuyen doi toa do thiet bi [0, width] x [0, height] sang NDC [-1, 1] x [-1, 1]
    let ndc_x = (input.position.x / uniforms.viewport_width) * 2.0 - 1.0;
    let ndc_y = 1.0 - (input.position.y / uniforms.viewport_height) * 2.0;

    out.clip_position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.uv = input.uv;
    out.color = input.color;
    out.flags = input.flags;
    out.alpha = input.alpha;

    return out;
}

fn path_alpha(in: VertexOutput) -> f32 {
    var coverage: f32 = 1.0;

    // Neu la duong cong Bezier (Loop-Blinn analytical AA: f(u, v) = u^2 - v)
    if ((in.flags & 1u) != 0u) {
        let u = in.uv.x;
        let v = in.uv.y;
        let f = u * u - v;

        // Tinh gradient theo screen space
        let grad = vec2<f32>(dpdx(f), dpdy(f));
        let grad_len = max(length(grad), 1e-4);

        // Khoang cach co dau toi bien duong cong tinh bang pixel
        let dist = f / grad_len;
        coverage = clamp(0.5 - dist, 0.0, 1.0);
    }

    if (coverage <= 0.0) {
        discard;
    }

    return clamp(in.alpha * coverage, 0.0, 1.0);
}

// PERF (audit 2026-09-25 §R25.GPU.04): chỉ pass coverage xuất alpha cho blend.
@fragment
fn fs_coverage(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(path_alpha(in));
}

@fragment
fn fs_path(in: VertexOutput) -> @location(0) vec4<f32> {
    return in.color * path_alpha(in);
}
