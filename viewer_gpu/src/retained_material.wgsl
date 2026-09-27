struct Params {extent:vec4<u32>,region:vec4<u32>,m0:vec4<f32>,m1:vec4<f32>,c0:vec4<f32>,c1:vec4<f32>,flags:vec4<u32>,bbox:vec4<f32>}
@group(0) @binding(0) var<storage,read_write> dst:array<f32>;
@group(0) @binding(1) var source:texture_2d_array<f32>;
@group(0) @binding(2) var tex_sampler:sampler;
@group(0) @binding(3) var<uniform> p:Params;
fn valid(t:f32)->bool {return (t>=0.0 || p.flags.x!=0u) && (t<=1.0 || p.flags.y!=0u);}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
    if any(id.xy>=p.region.zw) {return;}
    let xy=id.xy+p.region.xy;
    if any(xy>=p.extent.xy) {return;}
    let n=p.extent.z;let base=(xy.y*p.extent.x+xy.x)*(n+3u);let at=vec2<f32>(xy)+0.5;
    let pos=vec2(p.m0.x*at.x+p.m0.z*at.y+p.m1.x,p.m0.y*at.x+p.m0.w*at.y+p.m1.y);
    if any(pos<p.bbox.xy) || any(pos>p.bbox.zw) {return;}
    var uv=pos;var lod=0.0;
    if p.extent.w==0u {
        if any(uv<vec2(0.)) || any(uv>vec2(1.)) {return;}
        uv.y=1.0-uv.y;
        lod=max(0.,log2(max(length(p.m0.xy*p.m1.zw),length(p.m0.zw*p.m1.zw))));
    } else {
        var t=0.0;
        if p.extent.w==1u {
            let direction=p.c0.zw-p.c0.xy;let d=dot(direction,direction);
            if d<1e-7 {if p.flags.x==0u && p.flags.y==0u {return;}}else{t=dot(pos-p.c0.xy,direction)/d;}
            if !valid(t) {return;}
        } else {
            let v=vec2(p.c0.w,p.c1.x)-p.c0.xy;let dr=p.c1.y-p.c0.z;let f=pos-p.c0.xy;
            let a=dot(v,v)-dr*dr;let b=dot(f,v)+p.c0.z*dr;let c=dot(f,f)-p.c0.z*p.c0.z;
            var roots=vec2(-1e30);if abs(a)<1e-6 {if abs(b)>1e-9 {roots.x=c/(2.*b);}}
            else {let d=b*b-a*c;if d<0. {return;}roots=vec2(b+sqrt(d),b-sqrt(d))/a;}
            var found=false;t=-1e30;
            for(var i=0u;i<2u;i++) {let s=roots[i];if valid(s) && p.c0.z+s*dr>=0. {t=max(t,clamp(s,0.,1.));found=true;}}
            if !found {return;}
        }
        uv=vec2(clamp(t,0.,1.),0.5);
    }
    for(var ch=0u;ch<=n;ch++) {
        var color:vec4<f32>;
        if p.extent.w!=0u {color=textureLoad(source,vec2<i32>(i32(round(uv.x*255.)),0),i32(ch/4u),0);}
        else if lod==0. && p.flags.w==0u {color=textureLoad(source,min(vec2<i32>(uv*p.m1.zw),vec2<i32>(p.m1.zw)-1),i32(ch/4u),0);}
        else {color=textureSampleLevel(source,tex_sampler,uv,i32(ch/4u),lod);}
        dst[base+ch]=color[ch%4u];
    }
    let alpha=dst[base+n];dst[base+n+1u]=select(1.0,alpha,p.flags.z!=0u);dst[base+n+2u]=alpha;
}
