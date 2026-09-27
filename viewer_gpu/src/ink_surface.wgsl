// Mỗi pixel có [ink premultiplied..., alpha, shape, group-alpha].
struct Params { extent:vec4<u32>, region:vec4<u32>, flags:vec4<u32>, participation:vec4<u32>, opacity:vec4<f32> }
@group(0) @binding(0) var<storage,read_write> dst:array<f32>;
@group(0) @binding(1) var<storage,read> src:array<f32>;
@group(0) @binding(2) var<storage,read> initial:array<f32>;
@group(0) @binding(3) var<storage,read> coverage:array<u32>;
@group(0) @binding(4) var<storage,read> mask:array<f32>;
@group(0) @binding(5) var<storage,read> ink:array<f32>;
@group(0) @binding(6) var<storage,read> p:Params;
fn blend(b:f32,s:f32,m:u32)->f32 {
    var v=s;
    switch m {
        case 1u:{v=b*s;} case 2u:{v=b+s-b*s;}
        case 3u:{v=select(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),b>0.5);}
        case 4u:{v=min(b,s);} case 5u:{v=max(b,s);}
        case 6u:{v=select(min(1.0,b/max(1e-7,1.0-s)),1.0,s>=1.0);if b<=0.0 {v=0.0;}}
        case 7u:{v=select(1.0-min(1.0,(1.0-b)/max(s,1e-7)),0.0,s<=0.0);if b>=1.0 {v=1.0;}}
        case 8u:{v=select(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),s>0.5);}
        case 9u:{let d=select(((16.0*b-12.0)*b+4.0)*b,sqrt(b),b>0.25);
            v=select(b-(1.0-2.0*s)*b*(1.0-b),b+(2.0*s-1.0)*(d-b),s>0.5);}
        case 10u:{v=abs(b-s);} case 11u:{v=b+s-2.0*b*s;} default:{}
    }
    return clamp(v,0.0,1.0);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
    if any(id.xy>=p.region.zw) {return;}
    let xy=id.xy+p.region.xy;if any(xy>=p.extent.xy) {return;}
    let n=p.extent.z;let pixel=xy.y*p.extent.x+xy.x;let base=pixel*(n+3u);
    if p.extent.w==3u {
        var value=src[base+n];
        if p.flags.x!=0u {
            let k=clamp(src[base+3u],0.,1.);
            value=dot(vec3(0.3,0.59,0.11),(vec3(1.)-clamp(vec3(src[base],src[base+1u],src[base+2u]),vec3(0.),vec3(1.)))*(1.-k));
        }
        if p.opacity.w!=0. {value=ink[u32(round(clamp(value,0.,1.)*255.))];}
        dst[pixel]=clamp(value,0.,1.);return;
    }
    if p.extent.w==1u { // Bắt đầu nhóm non-isolated: giữ backdrop nhưng alpha nhóm bằng 0.
        dst[base+n+1u]=0.0;dst[base+n+2u]=0.0;return;
    }
    var f=p.opacity.y;var a=p.opacity.x;
    if p.participation.z==1u {f*=bitcast<f32>(coverage[pixel]);}
    if p.participation.z==2u {f*=bitcast<f32>(coverage[id.y*p.region.z+id.x]);}
    if p.participation.z>=3u {
        let at=select(pixel,id.y*p.region.z+id.x,p.participation.z==4u);
        f*=f32((coverage[at/2u]>>((at%2u)*16u))&65535u)/65025.;
    }
    var soft=1.0;if p.participation.w!=0u {soft=mask[pixel];}
    if p.opacity.z!=0.0 {f*=a*soft;a=1.0;} else {a*=soft;}
    if p.extent.w==2u || p.extent.w==4u {f*=src[base+n+1u];a*=src[base+n+2u]/max(src[base+n+1u],1e-7);}
    f=clamp(f,0.0,1.0);a=clamp(a*f,0.0,1.0);
    if f<=0.0 {return;}
    let old_a=dst[base+n];var ba=old_a;
    if p.flags.y!=0u {ba=initial[base+n];}
    for(var ch=0u;ch<n;ch++) {
        let prev=dst[base+ch];var bp=prev;if p.flags.y!=0u {bp=initial[base+ch];}
        let bc=select(0.0,bp/max(ba,1e-7),ba>0.0);var sc=ink[ch];
        if p.extent.w==2u {
            let ga=src[base+n+2u];var removal=0.0;
            if p.flags.w==0u {removal=(1.0-ga)*initial[base+ch];}
            sc=clamp((src[base+ch]-removal)/max(ga,1e-7),0.0,1.0);
        }
        let declared=select((p.participation.x&(1u<<(ch%32u)))!=0u,(p.participation.y&(1u<<(ch%32u)))!=0u,ch>=32u);
        if (p.flags.z&1u)!=0u && (!declared || ((p.flags.z&2u)!=0u && ch<4u && sc==0.)) {sc=bc;}
        let blended=1.0-blend(1.0-bc,1.0-sc,p.flags.x);
        let source_term=a*((1.0-ba)*sc+ba*blended);
        if p.flags.y!=0u {dst[base+ch]=(1.0-f)*prev+(f-a)*bp+source_term;}
        else {dst[base+ch]=(1.0-a)*prev+source_term;}
    }
    let old_g=dst[base+n+2u];
    if p.flags.y!=0u {dst[base+n]=(1.0-f)*old_a+(f-a)*ba+a;dst[base+n+2u]=(1.0-f)*old_g+a;}
    else {dst[base+n]=old_a+(1.0-old_a)*a;dst[base+n+2u]=old_g+(1.0-old_g)*a;}
    dst[base+n+1u]=dst[base+n+1u]+(1.0-dst[base+n+1u])*f;
}
