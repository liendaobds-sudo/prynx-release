override TARGET_SRGB:bool=false;
@group(0) @binding(0) var<storage,read> ink:array<f32>;
@group(0) @binding(1) var<storage,read> lut:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> spots:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> p:vec4<u32>;
@group(0) @binding(4) var<storage,read> page:vec4<f32>;
@vertex fn vs(@builtin(vertex_index) id:u32)->@builtin(position) vec4<f32> {
    let xy=array<vec2<f32>,3>(vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));return vec4(xy[id],0.,1.);
}
fn linear(v:vec3<f32>)->vec3<f32> {return select(v/12.92,pow((v+0.055)/1.055,vec3(2.4)),v>vec3(0.04045));}
@fragment fn fs(@builtin(position) pos:vec4<f32>)->@location(0) vec4<f32> {
    if any(pos.xy<page.xy) || any(pos.xy>=page.zw) {
        var background=vec3(82./255.,86./255.,89./255.);
        if TARGET_SRGB {background=linear(background);}return vec4(background,1.);
    }
    let xy=vec2<u32>(pos.xy);let base=(xy.y*p.x+xy.x)*(p.z+3u);
    var c=clamp(vec4(ink[base],ink[base+1u],ink[base+2u],ink[base+3u]),vec4(0.),vec4(1.));
    for(var ch=4u;ch<p.z;ch++) {
        let tint=clamp(ink[base+ch],0.,1.);if tint<=0. {continue;}
        let t=tint*32.;let lo=u32(floor(t));let offset=(ch-4u)*33u;
        c=min(vec4(1.),c+mix(spots[offset+lo],spots[offset+min(lo+1u,32u)],fract(t)));
    }
    let t=c*f32(p.w-1u);let lo=vec4<u32>(floor(t));let frac=fract(t);var rgb=vec3(0.);
    for(var corner=0u;corner<16u;corner++) {
        let bit=vec4<u32>(corner&1u,(corner>>1u)&1u,(corner>>2u)&1u,(corner>>3u)&1u);
        let at=min(lo+bit,vec4(p.w-1u));let f=select(vec4(1.)-frac,frac,bit==vec4(1u));
        let index=at.x+p.w*(at.y+p.w*(at.z+p.w*at.w));rgb+=lut[index].rgb*(f.x*f.y*f.z*f.w);
    }
    if TARGET_SRGB {rgb=linear(rgb);}return vec4(rgb,1.);
}
