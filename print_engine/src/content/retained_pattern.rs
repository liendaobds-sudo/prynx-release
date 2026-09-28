//! PERF (audit 2026-09-25 §R25.GPU.20): pattern giữ resource và clip trong PDF space.
use super::*;
impl Renderer<'_> {
    pub(super) fn retain_pattern(&mut self,target:&Path,rule:FillRule,stack:&StateStack,stroke:bool,resources:Option<&Dictionary>)->PpeResult<()> {
        let name=pattern_for(stack,stroke).ok_or_else(||PpeError::MalformedPdf("Pattern chưa chọn mẫu".into()))?;
        let raw=resources.and_then(|r|pdf::dict_get_dict(self.doc,r,"Pattern")).and_then(|d|d.get(name.as_bytes()).ok())
            .ok_or_else(||PpeError::MalformedPdf(format!("Thiếu pattern /{name}")))?;
        let entry=pdf::deref(self.doc,raw);
        let dict=match entry{Object::Dictionary(d)=>d,Object::Stream(s)=>&s.dict,_=>return Err(PpeError::MalformedPdf("Pattern không phải dictionary/stream".into()))};
        let m=pdf::dict_get(self.doc,dict,"Matrix").and_then(|v|pdf::num_array(self.doc,v)).and_then(|v|matrix_from_floats(&v)).unwrap_or(Matrix::IDENTITY).then(&self.stream_base_ctm);
        let mut initial=self.retained.as_ref().and_then(|r|r.stream_base.clone()).unwrap_or_else(||GraphicsState::initial(self.stream_base_ctm));
        initial.retained=stack.current().retained.clone();initial.retained.intersect(vec![target.clone()],rule);
        // ISO 32000 §11.6.7: toàn pattern là group non-isolated. ca/CA,
        // blend và mask ở lần gọi chỉ áp một lần lên kết quả của group.
        initial.fill_alpha=1.;initial.stroke_alpha=1.;initial.blend_mode=BlendMode::Normal;
        initial.retained.mask=None;
        let start=self.retained.as_ref().unwrap().commands.len();
        let kind=pdf::dict_get(self.doc,dict,"PatternType").and_then(pdf::as_num).unwrap_or(0.) as i32;
        if kind==2 {
            let obj=dict.get(b"Shading").map_err(|e|PpeError::MalformedPdf(e.to_string()))?;
            let cs=resolve_shading_colorspace(self.doc,obj,resources,&mut self.warnings)?;
            // MEMORY (audit 2026-09-28 §KNOCK.R1): registrar retained chỉ1px,
            // nên phải giữ cả budget request, không dựa riêng default của buffer.
            // Chốt này cho một lần resolve, chưa là lease cho toàn scene tích lũy.
            let remaining=self.opts.memory_budget_bytes.min(self.buffer.memory_limit_bytes())
                .saturating_sub(self.buffer.memory_used_bytes());
            let shading=crate::shading::resolve_shading_with_colorspace_bounded(
                self.doc,obj,cs,remaining,self.opts.cancellation_token())?;
            let mut state=StateStack::new(initial);
            if let Some(gs)=pdf::dict_get_dict(self.doc,dict,"ExtGState") {
                let mut res=Dictionary::new();res.set("ExtGState",lopdf::dictionary!{"PatternGS"=>gs.clone()});
                self.apply_ext_gstate("PatternGS",&res,&mut state,self.cur_depth)?;
            }
            let gs=state.current();let mut paint=InkPaint::opaque(vec![],ChannelMask::EMPTY);
            paint.alpha=if stroke{gs.stroke_alpha}else{gs.fill_alpha};paint.blend=gs.blend_mode;
            paint.overprint=self.opts.simulate_overprint && if stroke{gs.stroke_overprint}else{gs.fill_overprint};
            if let Some(background)=&shading.background {
                if let Some((ink,declared))=shading.colorspace.to_ink(background,self.buffer.space_mut(),&mut self.warnings,self.color)?{
                    self.retain_draw(RetainedKind::Path{path:target.clone(),rule},InkPaint::opaque(ink,declared),gs);
                }
            }
            self.retain_draw(RetainedKind::Shading{shading:Arc::new(shading),matrix:m},paint,gs);
            self.finish_retained_pattern(start,stack,stroke,true);return Ok(());
        }
        if kind!=1{return Err(PpeError::Unsupported(format!("PatternType {kind}")));}
        let Object::Stream(stream)=entry else{return Err(PpeError::MalformedPdf("Tiling pattern thiếu stream".into()));};
        let data=pdf::decode_stream(self.doc,stream);
        if data.quality!=pdf::DecodeQuality::Exact{return Err(PpeError::Unsupported("Pattern stream chỉ phục hồi được".into()));}
        let depth=self.cur_depth;
        if depth>=self.opts.max_form_depth{return Err(PpeError::Unsupported("Pattern lồng quá sâu".into()));}
        let b=pdf::dict_get(self.doc,dict,"BBox").and_then(|v|pdf::num_array(self.doc,v)).filter(|v|v.len()==4)
            .ok_or_else(||PpeError::MalformedPdf("Pattern thiếu BBox".into()))?;
        let bbox=Rect::new(b[0],b[1],b[2],b[3]);
        let xs=pdf::dict_get(self.doc,dict,"XStep").and_then(pdf::as_num).unwrap_or(bbox.width()).abs();
        let ys=pdf::dict_get(self.doc,dict,"YStep").and_then(pdf::as_num).unwrap_or(bbox.height()).abs();
        if !xs.is_finite() || !ys.is_finite() || xs==0. || ys==0. || bbox.is_empty(){return Err(PpeError::MalformedPdf("Bước/BBox pattern sai".into()));}
        let Some(inv)=m.invert() else{return Ok(());};
        let bounds=target.bounds();let mut bounds=Rect::new(bounds.left(),bounds.top(),bounds.right(),bounds.bottom());
        let mut clip=initial.retained.clip.as_ref();
        while let Some(c)=clip {
            let b=c.paths.iter().map(|p|p.bounds()).map(|b|Rect::new(b.left(),b.top(),b.right(),b.bottom())).reduce(|a,b|Rect::new(a.x0.min(b.x0),a.y0.min(b.y0),a.x1.max(b.x1),a.y1.max(b.y1)));
            let Some(b)=b.and_then(|b|bounds.intersect(&b))else{return Ok(());};bounds=b;clip=c.parent.as_ref();
        }
        let corners=[inv.apply(bounds.x0,bounds.y0),inv.apply(bounds.x0,bounds.y1),inv.apply(bounds.x1,bounds.y0),inv.apply(bounds.x1,bounds.y1)];
        let minx=corners.iter().map(|p|p.0).fold(f32::INFINITY,f32::min);let maxx=corners.iter().map(|p|p.0).fold(f32::NEG_INFINITY,f32::max);
        let miny=corners.iter().map(|p|p.1).fold(f32::INFINITY,f32::min);let maxy=corners.iter().map(|p|p.1).fold(f32::NEG_INFINITY,f32::max);
        let x0=((minx-bbox.x1)/xs).floor() as i64;let x1=((maxx-bbox.x0)/xs).ceil() as i64;
        let y0=((miny-bbox.y1)/ys).floor() as i64;let y1=((maxy-bbox.y0)/ys).ceil() as i64;
        let count=(x1 as i128-x0 as i128+1).checked_mul(y1 as i128-y0 as i128+1).unwrap_or(i128::MAX);
        let program=PageProgram::compile(&data.bytes)?;
        let minimum=count.saturating_mul(program.operation_count().max(1) as i128).saturating_mul(std::mem::size_of::<RetainedDraw>() as i128);
        if minimum>self.opts.memory_budget_bytes as i128{return Err(PpeError::Unsupported("Scene pattern vượt ngân sách RAM; cần PPE dependency replay".into()));}
        let uncolored=pdf::dict_get(self.doc,dict,"PaintType").and_then(pdf::as_num)==Some(2.);
        if uncolored {
            let caller=stack.current();
            let (cs,comps)=if stroke{(pattern_base_cs(&caller.stroke_cs),caller.stroke_comps.clone())}else{(pattern_base_cs(&caller.fill_cs),caller.fill_comps.clone())};
            let cs=cs.ok_or_else(||PpeError::MalformedPdf("Pattern không màu thiếu colorspace nền".into()))?;
            initial.fill_cs=cs.clone();initial.stroke_cs=cs;initial.fill_comps=comps.clone();initial.stroke_comps=comps;
        }else{initial.fill_cs=ColorSpace::DeviceGray;initial.stroke_cs=ColorSpace::DeviceGray;initial.fill_comps=vec![0.];initial.stroke_comps=vec![0.];}
        initial.fill_pattern=None;initial.stroke_pattern=None;
        let cell_res=pdf::dict_get_dict(self.doc,dict,"Resources");
        let saved_text=self.text_obj;let saved_base=self.stream_base_ctm;let saved_clip=std::mem::take(&mut self.retained.as_mut().unwrap().text_clip);
        let saved_suppress=self.suppress_color_ops;if uncolored{self.suppress_color_ops+=1;}
        let saved_owner=self.pattern_preview_owner;
        self.pattern_preview_owner=Some(self.preview_object_kind(PreviewObjectKind::LineArt));
        self.pattern_cell_depth+=1;
        let result=(||{
            for y in y0..=y1 {for x in x0..=x1 {
                self.opts.check_cancelled()?;
                let mut state=initial.clone();state.ctm=Matrix::translate(x as f32*xs,y as f32*ys).then(&m);
                let p=rect_path(bbox.x0,bbox.y0,bbox.width(),bbox.height()).and_then(|p|p.transform(to_ts(&state.ctm)));
                if let Some(p)=p {
                    let b=p.bounds();if bounds.intersect(&Rect::new(b.left(),b.top(),b.right(),b.bottom())).is_none(){continue;}
                    state.retained.intersect(vec![p],FillRule::NonZero);
                    self.execute_program(&program,cell_res,&mut StateStack::new(state),depth+1)?;
                }
            }}Ok(())
        })();
        self.pattern_cell_depth-=1;self.pattern_preview_owner=saved_owner;
        self.suppress_color_ops=saved_suppress;self.text_obj=saved_text;self.cur_depth=depth;self.stream_base_ctm=saved_base;self.retained.as_mut().unwrap().text_clip=saved_clip;
        result?;
        self.finish_retained_pattern(start,stack,stroke,false);Ok(())
    }
    fn finish_retained_pattern(&mut self,start:usize,stack:&StateStack,stroke:bool,knockout:bool){
        let commands=self.retained.as_mut().unwrap().commands.split_off(start);
        let gs=stack.current();let mut paint=self.retained_resource_paint(gs);
        if stroke{paint.alpha=gs.stroke_alpha;paint.overprint=self.opts.simulate_overprint && gs.stroke_overprint;}
        self.retain_draw(RetainedKind::Group{commands,isolated:false,knockout,blend_space:self.blend_space},paint,gs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn mesh_pattern_document() -> Document {
        let mut doc = Document::with_version("1.7");
        let mesh = Stream::new(dictionary! {
            "ShadingType"=>7, "ColorSpace"=>"DeviceGray", "BitsPerCoordinate"=>8,
            "BitsPerComponent"=>8, "BitsPerFlag"=>8,
            "Decode"=>vec![0.into(),100.into(),0.into(),100.into(),0.into(),1.into()],
        }, vec![0; 37 * 64]);
        let resources = dictionary! { "Pattern"=>dictionary! {
            "P"=>dictionary! {"PatternType"=>2,"Shading"=>Object::Stream(mesh)},
        }};
        let pages = doc.new_object_id();
        let contents = doc.add_object(Stream::new(Dictionary::new(),
            b"/Pattern cs /P scn 0 0 100 100 re f".to_vec()));
        let page = doc.add_object(dictionary! { "Type"=>"Page","Parent"=>pages,
            "MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()],
            "Resources"=>resources,"Contents"=>contents });
        doc.set_object(pages, dictionary! {"Type"=>"Pages","Kids"=>vec![Object::Reference(page)],"Count"=>1});
        let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
        doc.trailer.set("Root", catalog);
        doc
    }

    #[test]
    fn retained_mesh_pattern_obeys_request_budget_not_registrar_default() {
        let doc = mesh_pattern_document();
        let opts = RenderOptions::viewer().with_memory_budget_bytes(1024);
        assert!(matches!(
            RetainedPage::compile(&doc, 1, opts, None),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ), "registrar1px mặc định512MiB không được bỏ qua budget request1KiB");
    }

    #[test]
    fn retained_mesh_pattern_keeps_compact_patches_when_budget_is_sufficient() {
        let doc = mesh_pattern_document();
        let page = RetainedPage::compile(&doc, 1,
            RenderOptions::viewer().with_memory_budget_bytes(1024 * 1024), None).unwrap();
        assert_eq!(page.warnings.dropped_objects, 0);
        let RetainedKind::Group { commands, .. } = &page.commands[0].kind else { panic!("thiếu group pattern"); };
        let RetainedKind::Shading { shading, .. } = &commands[0].kind else { panic!("thiếu shading pattern"); };
        let ShadingKind::Patches { patches } = &shading.kind else { panic!("patch không được giữ gọn"); };
        assert_eq!(patches.len(), 64);
    }

    #[test]
    fn retained_mesh_pattern_preserves_cancellation() {
        let doc = mesh_pattern_document();
        let token = crate::cancel::CancelToken::new();
        token.cancel();
        assert!(matches!(RetainedPage::compile(&doc, 1,
            RenderOptions::viewer().with_cancel_token(token), None), Err(PpeError::Cancelled)));
    }
}
