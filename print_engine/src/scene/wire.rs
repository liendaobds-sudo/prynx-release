//! PERF (audit 2026-09-25 §R25.GPU.14): scene versioned qua pipe riêng của worker.
//! Resource/clip/mask dùng ID, giữ chia sẻ Arc sau decode; không truyền con trỏ.
use super::retained::*;
use crate::{content::BlendSpace, error::RenderWarnings, geom::{Matrix, Rect},
    image::sampler::SampledImage, ink::{InkPaint, InkSpace}, raster::FillRule, shading::Shading};
use serde::{Serialize, Deserialize};
use std::{collections::HashMap, io::{Read, Write}, sync::Arc};
use tiny_skia::{Path, PathBuilder, PathSegment};
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize)]
struct Clip { parent: Option<usize>, paths: Vec<Vec<Verb>>, rule: FillRule, stroke:Option<(Vec<Verb>,Matrix,RetainedStroke)> }
#[derive(Serialize, Deserialize)]
struct Mask { commands: Vec<Draw>, luminosity: bool, backdrop: InkPaint,
    blend_space: BlendSpace, transfer: Option<Vec<f32>> }
#[derive(Serialize, Deserialize)]
enum Kind {
    Path(Vec<Verb>, FillRule), Image(usize, Matrix, bool), Shading(usize, Matrix),
    Stroke(Vec<Verb>,Matrix,RetainedStroke),
    Group(Vec<Draw>, bool, bool, BlendSpace),
}
#[derive(Serialize, Deserialize)]
struct Draw { kind: Kind, paint: InkPaint, clip: Option<usize>, mask: Option<usize>,
    ais: bool, opm: i32, blend_space: BlendSpace }
#[derive(Serialize, Deserialize)]
enum Verb { Move(f32,f32), Line(f32,f32), Quad(f32,f32,f32,f32), Cubic(f32,f32,f32,f32,f32,f32), Close }
#[derive(Serialize, Deserialize)]
struct Packet {
    revision: u64, bounds: Rect, rotation: i32, user_unit: f32, warnings: RenderWarnings,
    space: InkSpace, commands: Vec<Draw>, clips: Vec<Clip>, masks: Vec<Mask>,
    images: Vec<Arc<SampledImage>>, shadings: Vec<Arc<Shading>>,
}
#[derive(Default)]
struct Encoder {
    clips: Vec<Clip>, masks: Vec<Mask>, images: Vec<Arc<SampledImage>>, shadings: Vec<Arc<Shading>>,
    clip_ids: HashMap<usize,usize>, mask_ids: HashMap<usize,usize>,
    image_ids: HashMap<usize,usize>, shading_ids: HashMap<usize,usize>,
}
fn key<T>(a: &Arc<T>) -> usize { Arc::as_ptr(a) as usize }
fn verbs(p: &Path) -> Vec<Verb> { p.segments().map(|s| match s {
    PathSegment::MoveTo(p)=>Verb::Move(p.x,p.y), PathSegment::LineTo(p)=>Verb::Line(p.x,p.y),
    PathSegment::QuadTo(a,b)=>Verb::Quad(a.x,a.y,b.x,b.y),
    PathSegment::CubicTo(a,b,c)=>Verb::Cubic(a.x,a.y,b.x,b.y,c.x,c.y), PathSegment::Close=>Verb::Close,
}).collect() }
fn path(v: Vec<Verb>) -> Result<Path> {
    let mut b=PathBuilder::new(); let mut started=false;
    for v in v { match v {
        Verb::Move(x,y) if x.is_finite() && y.is_finite()=>{ b.move_to(x,y);started=true; },
        Verb::Line(x,y) if started && x.is_finite() && y.is_finite()=>b.line_to(x,y),
        Verb::Quad(a,b0,c,d) if started && [a,b0,c,d].iter().all(|v|v.is_finite())=>b.quad_to(a,b0,c,d),
        Verb::Cubic(a,b0,c,d,e,f) if started && [a,b0,c,d,e,f].iter().all(|v|v.is_finite())=>b.cubic_to(a,b0,c,d,e,f),
        Verb::Close if started=>b.close(), _=>return Err("Path worker không hợp lệ".into()),
    }} b.finish().ok_or_else(||"Path worker rỗng".into())
}
impl Encoder {
    fn clip(&mut self, c: &Arc<RetainedClip>) -> usize {
        if let Some(i)=self.clip_ids.get(&key(c)){return *i;}
        let parent=c.parent.as_ref().map(|p|self.clip(p));let i=self.clips.len();
        self.clips.push(Clip{parent,paths:c.paths.iter().map(verbs).collect(),rule:c.rule,stroke:c.stroke.as_ref().map(|s|(verbs(&s.path),s.matrix,s.style.clone()))});
        self.clip_ids.insert(key(c),i);i
    }
    fn mask(&mut self, m: &Arc<RetainedMask>) -> usize {
        if let Some(i)=self.mask_ids.get(&key(m)){return *i;}
        let commands=self.draws(&m.commands);let i=self.masks.len();
        self.masks.push(Mask{commands,luminosity:m.luminosity,backdrop:m.backdrop.clone(),
            blend_space:m.blend_space,transfer:m.transfer.clone()});self.mask_ids.insert(key(m),i);i
    }
    fn draws(&mut self, ds: &[RetainedDraw]) -> Vec<Draw> {ds.iter().map(|d| {
        let clip=d.state.clip.as_ref().map(|c|self.clip(c));let mask=d.state.mask.as_ref().map(|m|self.mask(m));
        let kind=match &d.kind {
            RetainedKind::Path{path,rule}=>Kind::Path(verbs(path),*rule),
            RetainedKind::Stroke{path,matrix,style}=>Kind::Stroke(verbs(path),*matrix,style.clone()),
            RetainedKind::Group{commands,isolated,knockout,blend_space}=>Kind::Group(self.draws(commands),*isolated,*knockout,*blend_space),
            RetainedKind::Image{image,matrix,interpolate}=>{
                let i=*self.image_ids.entry(key(image)).or_insert_with(||{let i=self.images.len();self.images.push(image.clone());i});
                Kind::Image(i,*matrix,*interpolate)
            },
            RetainedKind::Shading{shading,matrix}=>{
                let i=*self.shading_ids.entry(key(shading)).or_insert_with(||{let i=self.shadings.len();self.shadings.push(shading.clone());i});
                Kind::Shading(i,*matrix)
            },
        };Draw{kind,paint:d.paint.clone(),clip,mask,ais:d.state.alpha_is_shape,opm:d.state.overprint_mode,blend_space:d.blend_space}
    }).collect()}
}
fn matrix(m: Matrix)->Result<Matrix>{if [m.a,m.b,m.c,m.d,m.e,m.f].iter().all(|v|v.is_finite()){Ok(m)}else{Err("Ma trận worker không hữu hạn".into())}}
fn paint(p: &InkPaint,n:usize)->Result<()> {
    if p.ink.len()>n || !p.alpha.is_finite() || !(0.0..=1.0).contains(&p.alpha)
        || p.ink.iter().any(|v|!v.is_finite()) || p.blend_rgb.is_some_and(|a|a.iter().any(|v|!v.is_finite())) {
        Err("Mực worker không hợp lệ".into())
    }else{Ok(())}
}
struct Decoder { clips:Vec<Arc<RetainedClip>>, masks:Vec<Arc<RetainedMask>>,
    images:Vec<Arc<SampledImage>>, shadings:Vec<Arc<Shading>>, channels:usize }
impl Decoder {
    fn draws(&self, ds:Vec<Draw>,depth:usize)->Result<Vec<RetainedDraw>> {
        if depth>64{return Err("Group worker lồng quá sâu".into());}
        ds.into_iter().map(|d| {
            paint(&d.paint,self.channels)?;
            let kind=match d.kind {
                Kind::Path(v,rule)=>RetainedKind::Path{path:path(v)?,rule},
                Kind::Stroke(v,m,style)=>{
                    if !style.is_valid(){return Err("Style stroke sai".into());}
                    RetainedKind::Stroke{path:path(v)?,matrix:matrix(m)?,style}
                },
                Kind::Image(i,m,interpolate)=>RetainedKind::Image{image:self.images.get(i).ok_or("ID ảnh sai")?.clone(),matrix:matrix(m)?,interpolate},
                Kind::Shading(i,m)=>RetainedKind::Shading{shading:self.shadings.get(i).ok_or("ID shading sai")?.clone(),matrix:matrix(m)?},
                Kind::Group(ds,isolated,knockout,blend_space)=>RetainedKind::Group{commands:self.draws(ds,depth+1)?,isolated,knockout,blend_space},
            };
            let clip=d.clip.map(|i|self.clips.get(i).cloned().ok_or("ID clip sai")).transpose()?;
            let mask=d.mask.map(|i|self.masks.get(i).cloned().ok_or("ID mask sai hoặc có vòng lặp")).transpose()?;
            Ok(RetainedDraw{kind,paint:d.paint,blend_space:d.blend_space,state:RetainedState{clip,mask,alpha_is_shape:d.ais,overprint_mode:d.opm}})
        }).collect()
    }
}
impl RetainedPage {
    /// Pipe nội bộ: magic/version + metadata + plane ảnh nhị phân.
    pub fn write_wire(&self, revision:u64, mut writer:impl Write)->Result<()> {
        let mut e=Encoder::default();let commands=e.draws(&self.commands);
        let packet=Packet{revision,bounds:self.bounds,rotation:self.rotation,user_unit:self.user_unit,warnings:self.warnings.clone(),space:self.space.clone(),
            commands,clips:e.clips,masks:e.masks,images:e.images,shadings:e.shadings};
        let bytes=serde_json::to_vec(&packet).map_err(|e|e.to_string())?;
        writer.write_all(b"PPEIR003").and_then(|_|writer.write_all(&(bytes.len() as u64).to_le_bytes()))
            .and_then(|_|writer.write_all(&bytes)).map_err(|e|e.to_string())?;
        for image in &packet.images {image.write_retained_payload(&mut writer).map_err(|e|e.to_string())?;}Ok(())
    }
    /// Budget là ngân sách host theo RAM, không phải trần chất lượng renderer.
    pub fn read_wire(mut reader:impl Read, revision:u64,budget:u64)->Result<Self> {
        let mut magic=[0;8];let mut len=[0;8];reader.read_exact(&mut magic).and_then(|_|reader.read_exact(&mut len)).map_err(|e|e.to_string())?;
        if &magic!=b"PPEIR003"{return Err("Phiên bản scene không tương thích".into());}
        let len=u64::from_le_bytes(len);if len>budget{return Err("Scene vượt ngân sách truyền của host".into());}
        let mut packet:Packet=serde_json::from_reader((&mut reader).take(len)).map_err(|e|e.to_string())?;
        if packet.revision!=revision{return Err("Scene thuộc revision cũ".into());}
        let b=packet.bounds;
        if ![b.x0,b.y0,b.x1,b.y1,packet.user_unit].iter().all(|v|v.is_finite()) || b.x1<=b.x0 || b.y1<=b.y0 || packet.user_unit<=0.
            || !(4..=64).contains(&packet.space.len()) || packet.rotation.rem_euclid(90)!=0 {
            return Err("Hình học hoặc kênh mực worker sai".into());
        }
        let mut remaining=budget-len;
        for image in &mut packet.images {Arc::get_mut(image).ok_or("Resource ảnh có alias trước decode")?.read_retained_payload(&mut reader,&mut remaining)?;}
        let mut d=Decoder{clips:Vec::new(),masks:Vec::new(),images:packet.images,shadings:packet.shadings,channels:packet.space.len()};
        for c in packet.clips {
            let parent=c.parent.map(|i|d.clips.get(i).cloned().ok_or("Clip có vòng lặp hoặc ID sai")).transpose()?;
            let paths=c.paths.into_iter().map(path).collect::<Result<Vec<_>>>()?;
            let stroke=c.stroke.map(|(p,m,style)|->Result<_>{if !style.is_valid(){return Err("Style clip stroke sai".into());}
                Ok(RetainedClipStroke{path:path(p)?,matrix:matrix(m)?,style})}).transpose()?;
            d.clips.push(Arc::new(RetainedClip{parent,paths,rule:c.rule,stroke}));
        }
        for m in packet.masks {
            paint(&m.backdrop,d.channels)?;
            if m.transfer.as_ref().is_some_and(|v|v.len()!=256 || v.iter().any(|x|!x.is_finite())){return Err("Transfer mask sai".into());}
            let commands=d.draws(m.commands,0)?;
            d.masks.push(Arc::new(RetainedMask{commands,luminosity:m.luminosity,backdrop:m.backdrop,blend_space:m.blend_space,transfer:m.transfer}));
        }
        Ok(Self{commands:d.draws(packet.commands,0)?,space:packet.space,bounds:b,rotation:packet.rotation,user_unit:packet.user_unit,warnings:packet.warnings})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scene()->RetainedPage {
        let path=PathBuilder::from_rect(tiny_skia::Rect::from_xywh(0.,0.,20.,20.).unwrap());
        let clip=Arc::new(RetainedClip{parent:None,paths:vec![path.clone()],rule:FillRule::NonZero,stroke:None});
        RetainedPage{commands:(0..2).map(|_|RetainedDraw{kind:RetainedKind::Path{path:path.clone(),rule:FillRule::NonZero},
            paint:InkPaint::opaque(vec![1.,0.,0.,0.],crate::ink::ChannelMask::PROCESS),
            state:RetainedState{clip:Some(clip.clone()),..Default::default()},blend_space:BlendSpace::DeviceCmyk}).collect(),
            space:InkSpace::new(),bounds:Rect::new(0.,0.,20.,20.),rotation:0,user_unit:1.,warnings:Default::default()}
    }
    #[test] fn roundtrip_preserves_shared_clip_and_revision(){
        let mut wire=Vec::new();scene().write_wire(41,&mut wire).unwrap();
        let decoded=RetainedPage::read_wire(&wire[..],41,1_000_000).unwrap();
        assert!(Arc::ptr_eq(decoded.commands[0].state.clip.as_ref().unwrap(),decoded.commands[1].state.clip.as_ref().unwrap()));
        assert!(RetainedPage::read_wire(&wire[..],42,1_000_000).is_err());
        assert!(RetainedPage::read_wire(&wire[..],41,10).is_err());
        assert!(RetainedPage::read_wire(&wire[..wire.len()/2],41,1_000_000).is_err());
    }
    #[test] fn malformed_clip_reference_is_rejected(){
        let mut e=Encoder::default();e.draws(&scene().commands);assert_eq!(e.clips.len(),1);
        assert!(path(vec![Verb::Line(1.,2.)]).is_err());
        assert!(path(vec![Verb::Move(f32::NAN,0.)]).is_err());
    }
}
