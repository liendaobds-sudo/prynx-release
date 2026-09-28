//! Backend ghi display list; chia sẻ tokenizer, text engine và state machine PPE.
use super::*;
use crate::scene::retained::*;
use crate::ink::InkSpace;
#[path = "retained_pattern.rs"]
mod pattern;

/// MEMORY (audit 2026-09-28 §KNOCK.R2): replay resource dùng budget suy từ công
/// việc, không phải cap chất lượng. Mesh còn cần owner/UV, lưới patch tạm và mọi
/// capacity raw đang sống; công thức raster cũ không đủ ngay cả với ảnh 2×2.
fn shading_replay_memory_bytes(shading:&Shading,width:u32,height:u32,channels:usize)->PpeResult<usize> {
    let overflow=||PpeError::Unsupported("Kích thước shading vượt địa chỉ bộ nhớ".into());
    let pixels=(width as usize).checked_mul(height as usize).ok_or_else(overflow)?;
    let base=pixels.checked_mul(channels.checked_add(8).ok_or_else(overflow)?)
        .and_then(|v|v.checked_mul(std::mem::size_of::<f32>())).ok_or_else(overflow)?;
    let resource=match &shading.kind {
        ShadingKind::Mesh{triangles}=>{
            let mut bytes=triangles.capacity().checked_mul(std::mem::size_of::<crate::shading::mesh::MeshTriangle>()).ok_or_else(overflow)?;
            for triangle in triangles {for values in &triangle.c {
                bytes=bytes.checked_add(values.capacity().checked_mul(std::mem::size_of::<f32>()).ok_or_else(overflow)?).ok_or_else(overflow)?;
            }}bytes
        },
        ShadingKind::Patches{patches}=>{
            let mut bytes=patches.capacity().checked_mul(std::mem::size_of::<crate::shading::mesh::MeshPatch>()).ok_or_else(overflow)?;
            for patch in patches {for values in &patch.c {
                bytes=bytes.checked_add(values.capacity().checked_mul(std::mem::size_of::<f32>()).ok_or_else(overflow)?).ok_or_else(overflow)?;
            }}bytes
        },
        _=>return Ok(base),
    };
    // Owner usize + ba tọa độ và padding: dự phòng 32 byte/pixel, không giảm DPI.
    pixels.checked_mul(32).and_then(|v|v.checked_add(std::mem::size_of::<crate::shading::mesh::MeshPatchGrid>()))
        .and_then(|v|v.checked_add(resource)).and_then(|v|v.checked_add(base)).ok_or_else(overflow)
}

impl<'a> Renderer<'a> {
    /// PERF (audit 2026-09-25 §R25.GPU.24): fallback chỉ replay resource đã
    /// phân giải, không parse/render lại trang. Kết quả còn nguyên các kênh mực.
    pub fn replay_shading_resource(shading:&Shading,matrix:Matrix,width:u32,height:u32,
        space:InkSpace,color:&ColorManager)->PpeResult<(InkBuffer,RenderWarnings)> {
        let doc=Document::new();
        let bytes=shading_replay_memory_bytes(shading,width,height,space.len())?;
        let opts=RenderOptions::viewer().with_memory_budget_bytes(bytes);
        let buffer=InkBuffer::new_with_memory_budget(width,height,space,bytes)?;
        let mut renderer=Renderer::new(&doc,buffer,opts,Some(color),BlendSpace::DeviceCmyk)?;
        if let ShadingKind::FunctionBased{domain,matrix:local}=&shading.kind {
            // Type 1 nhận hai input (x,y); không dùng LUT một chiều của axial.
            let function=shading.function.as_ref().ok_or_else(||PpeError::MalformedPdf("Type 1 thiếu Function".into()))?;
            let Some(inv)=local.then(&matrix).invert() else{return Ok(renderer.into_parts());};
            let inv_shading=matrix.invert().unwrap();
            for y in 0..height{for x in 0..width{
                let (sx,sy)=inv_shading.apply(x as f32+0.5,y as f32+0.5);
                if shading.bbox.is_some_and(|b|sx<b.x0 || sx>b.x1 || sy<b.y0 || sy>b.y1){continue;}
                let (u,v)=inv.apply(x as f32+0.5,y as f32+0.5);
                if u<domain[0] || u>domain[1] || v<domain[2] || v>domain[3]{continue;}
                let comps=function.eval(&[u,v]);
                if let Some((ink,declared))=shading.colorspace.to_ink(&comps,renderer.buffer.space_mut(),&mut renderer.warnings,Some(color))?{
                    renderer.buffer.sync_channels()?;renderer.buffer.composite_at((y*width+x) as usize,1.,&InkPaint::opaque(ink,declared));
                }
            }}
        }else{
            let mut state=GraphicsState::initial(matrix);
            if let Some(b)=shading.bbox{
                let mut clip=Mask::new(width,height).ok_or_else(||PpeError::Unsupported("Không cấp được clip shading".into()))?;
                if let Some(path)=rect_path(b.x0,b.y0,b.width(),b.height()){clip.fill_path(&path,tiny_skia::FillRule::Winding,true,to_ts(&matrix));}
                state.clip=Some(Arc::new(clip));
            }
            let stack=StateStack::new(state);
            renderer.paint_shading(shading,&matrix,ShadingCoverage::GraphicsState{clip:stack.current().clip.as_deref(),soft_mask:None,width:width as usize},Region::full(width,height),&stack,false)?;
        }
        Ok(renderer.into_parts())
    }

    pub fn compile_retained_page(doc: &'a Document, page: usize, opts: RenderOptions,
        color: Option<&'a ColorManager>) -> PpeResult<RetainedPage> {
        let descriptor = crate::page::build_page_descriptor(doc, page)?;
        let bounds = descriptor.crop.and_then(|b| b.intersect(&descriptor.media)).unwrap_or(descriptor.media);
        let page_dict = doc.get_dictionary(descriptor.page_id)
            .map_err(|e| PpeError::MalformedPdf(e.to_string()))?;
        let user_unit = pdf::dict_get(doc, page_dict, "UserUnit").and_then(pdf::as_num).unwrap_or(1.0);
        if !user_unit.is_finite() || user_unit <= 0.0 {
            return Err(PpeError::MalformedPdf("UserUnit không hợp lệ".into()));
        }
        // Một pixel chỉ để registrar của InkSpace hoạt động; recorder không raster.
        let buffer = InkBuffer::new(1, 1, InkSpace::preview())?;
        let mut renderer = Self::new(doc, buffer, opts.clone(), color, descriptor.blend_space)?;
        renderer.retained = Some(Recorder::default());
        let program = PageProgram::compile(&doc.get_page_content(descriptor.page_id))?;
        let mut state = GraphicsState::initial(Matrix::IDENTITY);
        state.retained.intersect(vec![rect_path(bounds.x0, bounds.y0, bounds.width(), bounds.height())
            .ok_or_else(|| PpeError::MalformedPdf("CropBox rỗng".into()))?], FillRule::NonZero);
        renderer.execute_program(&program, descriptor.resources.as_ref(), &mut StateStack::new(state), 0)?;
        if opts.renders_annotations() && page_dict.get(b"Annots").is_ok() {
            crate::page::render_annotation_appearances(doc,descriptor.page_id,&mut renderer,Matrix::IDENTITY)?;
        }
        Ok(RetainedPage { commands: renderer.retained.take().unwrap().commands,
            space: renderer.buffer.space().clone(), bounds, rotation: descriptor.rotate,
            user_unit, warnings: renderer.warnings })
    }

    pub(super) fn retain_draw(&mut self, kind: RetainedKind, paint: InkPaint, state: &GraphicsState) {
        let mut retained = state.retained.clone();
        retained.overprint_mode = state.overprint_mode;
        self.retained.as_mut().unwrap().commands.push(RetainedDraw {
            kind, paint, state: retained, blend_space: self.blend_space });
    }

    // PERF (audit 2026-09-25 §R25.GPU.21): ảnh/shading/group có màu riêng.
    // /None của màu fill không được xóa ca/BM/op tại lần gọi resource.
    fn retained_resource_paint(&self, state: &GraphicsState) -> InkPaint {
        let mut paint = InkPaint::opaque(vec![], ChannelMask::EMPTY);
        paint.alpha = state.fill_alpha.clamp(0.0, 1.0);
        paint.blend = state.blend_mode;
        paint.overprint = self.opts.simulate_overprint && state.fill_overprint;
        paint
    }

    pub(super) fn retain_path(&mut self, path: Option<Path>, fill: Option<FillRule>, stroke: bool,
        clip: Option<FillRule>, stack: &mut StateStack, resources:Option<&Dictionary>) -> PpeResult<()> {
        let ctm = stack.current().ctm;
        let device = path.as_ref().and_then(|p| p.clone().transform(to_ts(&ctm)));
        if let (Some(rule), Some(p)) = (fill, device.as_ref()) {
            if uses_pattern_color_space(stack,false) {
                self.retain_pattern(p,rule,stack,false,resources)?;
            }else if let Some(paint) = self.make_paint(stack, false)? {
                self.retain_draw(RetainedKind::Path { path: p.clone(), rule }, paint, stack.current());
            }
        }
        if stroke {
            if let Some(p) = path.as_ref() {
                if uses_pattern_color_space(stack,true) {
                    // PERF (audit 2026-09-25 §R25.GPU.23): không đóng băng
                    // hairline/dash của pattern ở DPI compile. BBox chỉ để cull.
                    let mut initial=stack.current().clone();
                    let mut clip=initial.retained.clip.as_ref();let mut bounds=None;
                    while let Some(c)=clip {
                        let b=c.paths.iter().map(|p|p.bounds()).map(|b|Rect::new(b.left(),b.top(),b.right(),b.bottom()))
                            .reduce(|a,b|Rect::new(a.x0.min(b.x0),a.y0.min(b.y0),a.x1.max(b.x1),a.y1.max(b.y1)));
                        bounds=match (bounds,b){(None,b)=>b,(Some(a),Some(b))=>a.intersect(&b),_=>None};
                        if bounds.is_none(){return Ok(());}clip=c.parent.as_ref();
                    }
                    let b=bounds.ok_or_else(||PpeError::MalformedPdf("Pattern stroke thiếu clip trang".into()))?;
                    let target=rect_path(b.x0,b.y0,b.width(),b.height()).ok_or_else(||PpeError::MalformedPdf("Clip pattern rỗng".into()))?;
                    initial.retained.clip=Some(Arc::new(RetainedClip {parent:initial.retained.clip.clone(),paths:vec![target.clone()],rule:FillRule::NonZero,
                        stroke:Some(RetainedClipStroke{path:p.clone(),matrix:ctm,style:RetainedStroke::from_state(&initial)})}));
                    self.retain_pattern(&target,FillRule::NonZero,&StateStack::new(initial),true,resources)?;
                }else if let Some(paint) = self.make_paint(stack, true)? {
                    self.retain_draw(RetainedKind::Stroke { path: p.clone(),matrix:ctm,style:crate::scene::retained::RetainedStroke::from_state(stack.current()) }, paint, stack.current());
                }
            }
        }
        if let Some(rule) = clip {
            stack.current_mut().retained.intersect(device.into_iter().collect(), rule);
        }
        Ok(())
    }

    pub(super) fn retain_glyph(&mut self, outline: &Path, trm: Matrix, mode: TextRenderMode,
        stack: &mut StateStack, resources:Option<&Dictionary>) -> PpeResult<()> {
        let path = outline.clone().transform(to_ts(&trm));
        self.retain_path(path.clone(), mode.fills().then_some(FillRule::NonZero), mode.strokes(), None, stack, resources)?;
        if mode.adds_to_clip() {
            if let Some(path) = path.and_then(|p| p.transform(to_ts(&stack.current().ctm))) {
                self.retained.as_mut().unwrap().text_clip.push(path);
            }
        }
        Ok(())
    }

    pub(super) fn retain_image(&mut self, entry: &Object, resources: Option<&Dictionary>,
        stack: &mut StateStack) -> PpeResult<()> {
        let image = self.decode_image_cached(entry, resources)?;
        if image.explicit_mask_decode_failed {
            return Err(PpeError::Unsupported("Scene ảnh có explicit mask lỗi".into()));
        }
        let paint = if image.stencil.is_some() {
            let Some(paint) = self.make_paint(stack, false)? else { return Ok(()); };
            paint
        } else { self.retained_resource_paint(stack.current()) };
        let interpolate = match pdf::deref(self.doc, entry) {
            Object::Stream(s) => pdf::dict_get(self.doc, &s.dict, "Interpolate").and_then(as_bool).unwrap_or(false),
            _ => false,
        };
        self.retain_draw(RetainedKind::Image { image, matrix: stack.current().ctm, interpolate }, paint, stack.current());
        Ok(())
    }

    pub(super) fn retain_shading(&mut self, shading: Shading, stack: &mut StateStack) -> PpeResult<()> {
        let paint = self.retained_resource_paint(stack.current());
        self.retain_draw(RetainedKind::Shading { shading: Arc::new(shading), matrix: stack.current().ctm }, paint, stack.current());
        Ok(())
    }

    pub(super) fn retain_form(&mut self, stream: &lopdf::Stream, key: Option<ObjectId>,
        resources: Option<&Dictionary>, initial: GraphicsState, depth: u32,
        blend_space: BlendSpace) -> PpeResult<Vec<RetainedDraw>> {
        let matrix = pdf::dict_get(self.doc, &stream.dict, "Matrix")
            .and_then(|v| pdf::num_array(self.doc, v)).and_then(|v| matrix_from_floats(&v)).unwrap_or(Matrix::IDENTITY);
        let mut initial = initial;
        initial.ctm = matrix.then(&initial.ctm);
        if let Some(v) = pdf::dict_get(self.doc, &stream.dict, "BBox").and_then(|v| pdf::num_array(self.doc, v)) {
            if v.len() >= 4 {
                let b = Rect::new(v[0], v[1], v[2], v[3]);
                let path = rect_path(b.x0, b.y0, b.width(), b.height()).and_then(|p| p.transform(to_ts(&initial.ctm)));
                initial.retained.intersect(path.into_iter().collect(), FillRule::NonZero);
            }
        }
        let source = self.form_source(key, stream)?;
        if source.quality() != pdf::DecodeQuality::Exact {
            return Err(PpeError::Unsupported("Content Form không giải mã chính xác".into()));
        }
        let saved = std::mem::replace(self.retained.as_mut().unwrap(), Recorder::default());
        let old_blend = std::mem::replace(&mut self.blend_space, blend_space);
        let saved_text = self.text_obj;
        let result = self.execute_source(StreamSource::Form(&source), resources, &mut StateStack::new(initial), depth + 1);
        self.text_obj = saved_text;
        self.blend_space = old_blend;
        let child = std::mem::replace(self.retained.as_mut().unwrap(), saved);
        result?;
        Ok(child.commands)
    }

    pub(super) fn retain_xobject(&mut self, name: &str, resources: &Dictionary,
        stack: &mut StateStack, depth: u32) -> PpeResult<()> {
        if self.oc_hidden_now() { return Ok(()); }
        let entry = pdf::dict_get_dict(self.doc, resources, "XObject")
            .and_then(|d| d.get(name.as_bytes()).ok()).cloned()
            .ok_or_else(|| PpeError::MalformedPdf(format!("Thiếu XObject /{name}")))?;
        let Object::Stream(stream) = pdf::deref(self.doc, &entry) else {
            return Err(PpeError::MalformedPdf("XObject không phải stream".into()));
        };
        if self.xobject_oc_hidden(stream.dict.get(b"OC").ok().cloned()) { return Ok(()); }
        let subtype = pdf::dict_get(self.doc, &stream.dict, "Subtype").and_then(pdf::name_str);
        if subtype.as_deref() == Some("Image") { return self.retain_image(&entry, Some(resources), stack); }
        if subtype.as_deref() != Some("Form") { return Err(PpeError::Unsupported(format!("XObject {subtype:?}"))); }
        let group = pdf::dict_get_dict(self.doc, &stream.dict, "Group")
            .filter(|g| pdf::dict_get(self.doc, g, "S").and_then(pdf::name_str).as_deref() == Some("Transparency"));
        let isolated = group.and_then(|g| pdf::dict_get(self.doc, g, "I")).and_then(as_bool).unwrap_or(false);
        let knockout = group.and_then(|g| pdf::dict_get(self.doc, g, "K")).and_then(as_bool).unwrap_or(false);
        let form_res = pdf::dict_get_dict(self.doc, &stream.dict, "Resources").or(Some(resources));
        let blend_space = if isolated {
            match group.and_then(|g| g.get(b"CS").ok()) {
                Some(cs) => blend_space_for_colorspace(&resolve_colorspace(self.doc, cs, form_res, &mut self.warnings)?),
                None => self.blend_space,
            }
        } else { self.blend_space };
        let mut initial = stack.current().clone();
        if group.is_some() {
            initial.fill_alpha = 1.0; initial.stroke_alpha = 1.0;
            initial.blend_mode = BlendMode::Normal;
            initial.retained.mask = None;
        }
        let children = self.retain_form(stream, pdf::ref_id(&entry), form_res, initial, depth, blend_space)?;
        if group.is_some() {
            let paint = self.retained_resource_paint(stack.current());
            self.retain_draw(RetainedKind::Group { commands: children, isolated, knockout, blend_space }, paint, stack.current());
        } else { self.retained.as_mut().unwrap().commands.extend(children); }
        Ok(())
    }

    pub(super) fn retain_soft_mask(&mut self, obj: &Object, stack: &StateStack, depth: u32) -> PpeResult<Option<Arc<RetainedMask>>> {
        if pdf::name_str(obj).as_deref() == Some("None") { return Ok(None); }
        if self.smask_depth >= MAX_SOFT_MASK_DEPTH { return Err(PpeError::Unsupported("Soft mask lồng quá sâu".into())); }
        let Object::Dictionary(mask) = pdf::deref(self.doc, obj) else { return Err(PpeError::MalformedPdf("SMask không phải dictionary".into())); };
        let luminosity = match pdf::dict_get(self.doc, mask, "S").and_then(pdf::name_str).as_deref() {
            Some("Luminosity") => true, Some("Alpha") => false,
            _ => return Err(PpeError::MalformedPdf("SMask thiếu subtype hợp lệ".into())),
        };
        let entry = mask.get(b"G").map_err(|e| PpeError::MalformedPdf(e.to_string()))?;
        let Object::Stream(stream) = pdf::deref(self.doc, entry) else { return Err(PpeError::MalformedPdf("SMask thiếu Form /G".into())); };
        let resources = pdf::dict_get_dict(self.doc, &stream.dict, "Resources");
        let cs = match pdf::dict_get_dict(self.doc, &stream.dict, "Group").and_then(|g| g.get(b"CS").ok()) {
            Some(cs) => resolve_colorspace(self.doc, cs, resources, &mut self.warnings)?,
            None => ColorSpace::DeviceGray,
        };
        let blend_space = blend_space_for_colorspace(&cs);
        let comps = pdf::dict_get(self.doc, mask, "BC").and_then(|o| pdf::num_array(self.doc, o)).unwrap_or_else(|| cs.initial_components());
        let (ink, declared) = cs.to_ink(&comps, self.buffer.space_mut(), &mut self.warnings, self.color)?
            .unwrap_or((vec![], ChannelMask::EMPTY));
        self.buffer.sync_channels()?;
        let mut backdrop = InkPaint::opaque(ink, declared);
        backdrop.blend_rgb = cs.to_device_rgb_for_blending(&comps);
        backdrop.alpha = if luminosity { 1.0 } else { 0.0 };
        let transfer = match pdf::dict_get(self.doc, mask, "TR") {
            Some(obj) if pdf::name_str(obj).as_deref() != Some("Identity") => {
                let f = resolve_function(self.doc, obj)?;
                Some((0..256).map(|i| f.eval(&[i as f32/255.0]).first().copied().unwrap_or(0.0).clamp(0.0,1.0)).collect())
            }, _ => None,
        };
        self.smask_depth += 1;
        let commands = self.retain_form(stream, pdf::ref_id(entry), resources,
            GraphicsState::initial(stack.current().ctm), depth, blend_space);
        self.smask_depth -= 1;
        Ok(Some(Arc::new(RetainedMask { commands: commands?, luminosity, backdrop, blend_space, transfer })))
    }
}

fn matrix_from_floats(v: &[f32]) -> Option<Matrix> {
    (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    #[test]
    fn compact_mesh_replay_budget_counts_spare_capacity_and_rejects_overflow() {
        use crate::shading::mesh::{MeshPatch,MeshPatchGrid,MeshTriangle};
        let raw_values=||{let mut values=Vec::with_capacity(8);values.push(0.);values};
        let mut patches=Vec::with_capacity(4);
        patches.push(MeshPatch{grid:[[0.,0.];16],c:std::array::from_fn(|_|raw_values())});
        let resource_bytes=patches.capacity()*std::mem::size_of::<MeshPatch>()
            +patches[0].c.iter().map(|values|values.capacity()*std::mem::size_of::<f32>()).sum::<usize>();
        let shading=Shading{kind:ShadingKind::Patches{patches},colorspace:ColorSpace::DeviceGray,
            function:None,bbox:None,background:None};
        let raster_bytes=4*((4+8)*4+32)+std::mem::size_of::<MeshPatchGrid>();
        assert_eq!(shading_replay_memory_bytes(&shading,2,2,4).unwrap(),raster_bytes+resource_bytes);
        assert!(shading_replay_memory_bytes(&shading,u32::MAX,u32::MAX,64).is_err());
        let mut triangles=Vec::with_capacity(3);
        triangles.push(MeshTriangle{p:[[0.,0.];3],c:std::array::from_fn(|_|raw_values())});
        let resource_bytes=triangles.capacity()*std::mem::size_of::<MeshTriangle>()
            +triangles[0].c.iter().map(|values|values.capacity()*std::mem::size_of::<f32>()).sum::<usize>();
        let shading=Shading{kind:ShadingKind::Mesh{triangles},colorspace:ColorSpace::DeviceGray,
            function:None,bbox:None,background:None};
        assert_eq!(shading_replay_memory_bytes(&shading,2,2,4).unwrap(),raster_bytes+resource_bytes);
    }

    #[test]
    fn two_pixel_patch_replay_evaluates_nonlinear_function_after_raw_interpolation() {
        use crate::color::{PdfFunction,RenderIntent};
        use crate::shading::mesh::MeshPatch;
        let shading=Shading{kind:ShadingKind::Patches{patches:vec![MeshPatch{
            grid:std::array::from_fn(|i|[(i%4) as f32/3.,(i/4) as f32/3.]),
            c:[vec![0.],vec![1.],vec![1.],vec![0.]],
        }]},colorspace:ColorSpace::DeviceCMYK,function:Some(PdfFunction::Exponential{
            domain:vec![0.,1.],c0:vec![0.;4],c1:vec![0.,0.,0.,1.],n:2.,range:None,
        }),bbox:None,background:None};
        let profile=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc");
        let cm=ColorManager::from_cmyk_profile(&profile,RenderIntent::RelativeColorimetric).unwrap();
        let (buffer,warnings)=Renderer::replay_shading_resource(&shading,Matrix::scale(2.,2.),2,2,InkSpace::preview(),&cm).unwrap();
        assert!(!warnings.ink_unsound(),"{warnings:?}");
        for (index,expected) in [0.0625,0.5625,0.0625,0.5625].into_iter().enumerate(){
            assert!((buffer.plane(3)[index]-expected).abs()<1e-5);
            assert_eq!(buffer.alpha_plane()[index],1.);
        }
    }

    fn document(content: &[u8], resources: Dictionary) -> Document {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let contents = doc.add_object(Stream::new(Dictionary::new(), content.to_vec()));
        let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(),0.into(),100.into(),100.into()],
            "Resources" => resources, "Contents" => contents });
        doc.objects.insert(pages, dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1}.into());
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        doc
    }

    #[test]
    fn retained_clip_is_geometry_and_q_restores_its_identity() {
        let doc = document(b"q 10 10 20 20 re W n 1 0 0 0 k 0 0 80 80 re f Q 0 1 0 0 k 60 60 20 20 re f", Dictionary::new());
        let scene = RetainedPage::compile(&doc, 1, RenderOptions::softproof(), None).unwrap();
        assert_eq!(scene.commands.len(),2);
        let inner = scene.commands[0].state.clip.as_ref().unwrap();
        let outer = scene.commands[1].state.clip.as_ref().unwrap();
        assert!(Arc::ptr_eq(inner.parent.as_ref().unwrap(),outer));
        assert_eq!(inner.paths[0].bounds().width(),20.0);
        assert_eq!(scene.commands[0].paint.ink,vec![1.0,0.0,0.0,0.0]);
    }

    #[test]
    fn retained_form_resolves_local_resources_and_normalizes_group_alpha() {
        let form = Stream::new(dictionary! { "Subtype" => "Form",
            "BBox" => vec![0.into(),0.into(),20.into(),20.into()],
            "Group" => dictionary! {"S"=>"Transparency", "I"=>true},
            "Resources" => dictionary! {"ExtGState" => dictionary! {"local"=>dictionary! {"ca"=>0.8}}}},
            b"/local gs 0 0 0 1 k 0 0 20 20 re f".to_vec());
        let doc = document(b"/outer gs /F Do", dictionary! {
            "ExtGState"=>dictionary! {"outer"=>dictionary! {"ca"=>0.5}},
            "XObject"=>dictionary! {"F"=>Object::Stream(form)}});
        let scene = RetainedPage::compile(&doc,1,RenderOptions::softproof(),None).unwrap();
        assert_eq!(scene.commands[0].paint.alpha,0.5);
        let RetainedKind::Group {commands,isolated,..} = &scene.commands[0].kind else {panic!("thiếu group")};
        assert!(*isolated);
        assert_eq!(commands[0].paint.alpha,0.8);
    }

    #[test]
    fn retained_mask_is_anchored_at_gs_and_cleared_by_none() {
        let form = Stream::new(dictionary! {"Subtype"=>"Form", "BBox"=>vec![0.into(),0.into(),20.into(),20.into()],
            "Group"=>dictionary! {"S"=>"Transparency","CS"=>"DeviceGray"}}, b"1 g 0 0 20 20 re f".to_vec());
        let doc=document(b"/M gs 1 0 0 1 50 0 cm 0 0 10 10 re f /N gs 20 0 10 10 re f",dictionary! {
            "ExtGState"=>dictionary! {"M"=>dictionary! {"SMask"=>dictionary! {"S"=>"Luminosity","G"=>Object::Stream(form)}},
                "N"=>dictionary! {"SMask"=>"None"}}});
        let scene=RetainedPage::compile(&doc,1,RenderOptions::softproof(),None).unwrap();
        let mask=scene.commands[0].state.mask.as_ref().unwrap();
        let RetainedKind::Path {path,..}=&mask.commands[0].kind else {panic!("thiếu path mask")};
        assert_eq!(path.bounds().left(),0.0);
        let RetainedKind::Path {path,..}=&scene.commands[0].kind else {panic!("thiếu path")};
        assert_eq!(path.bounds().left(),50.0);
        assert!(scene.commands[1].state.mask.is_none());
    }

    #[test]
    fn hairline_dash_is_camera_dependent_and_keeps_gaps() {
        let doc=document(b"0 w [5 5] 0 d 0 10 m 100 10 l S",Dictionary::new());
        let scene=RetainedPage::compile(&doc,1,RenderOptions::softproof(),None).unwrap();
        let RetainedKind::Stroke{path,matrix,style}=&scene.commands[0].kind else{panic!("thiếu stroke retained")};
        for scale in [1.,4.,16.] {
            let p=style.device_path(path,matrix.then(&Matrix::scale(scale,scale))).unwrap();
            assert!((p.bounds().height()-1.).abs()<0.001);
            let mut mask=tiny_skia::Mask::new((100.*scale) as u32,(20.*scale) as u32).unwrap();
            mask.fill_path(&p,tiny_skia::FillRule::Winding,false,tiny_skia::Transform::identity());
            let row=(10.*scale) as usize*mask.width() as usize;
            assert!(mask.data()[row+(2.*scale) as usize]>0);
            assert_eq!(mask.data()[row+(7.*scale) as usize],0);
        }
    }

    #[test]
    fn retained_type3_uses_charproc_resources_and_text_advance() {
        let glyph=Stream::new(Dictionary::new(),b"500 0 0 0 500 700 d1 0 0 500 700 re f".to_vec());
        let font=dictionary!{"Type"=>"Font","Subtype"=>"Type3","FontBBox"=>vec![0.into(),0.into(),500.into(),700.into()],
            "FontMatrix"=>vec![0.001.into(),0.into(),0.into(),0.001.into(),0.into(),0.into()],
            "CharProcs"=>dictionary!{"A"=>Object::Stream(glyph)},"Encoding"=>dictionary!{"Type"=>"Encoding","Differences"=>vec![65.into(),"A".into()]},
            "FirstChar"=>65,"LastChar"=>65,"Widths"=>vec![500.into()],"Resources"=>Dictionary::new()};
        let doc=document(b"BT /F 20 Tf 10 20 Td (AA) Tj ET",dictionary!{"Font"=>dictionary!{"F"=>font}});
        let scene=RetainedPage::compile(&doc,1,RenderOptions::softproof(),None).unwrap();
        assert_eq!(scene.commands.len(),2);assert_eq!(scene.warnings.dropped_objects,0);
        let bounds:Vec<_>=scene.commands.iter().map(|d|match &d.kind{RetainedKind::Path{path,..}=>path.bounds(),_=>panic!()}).collect();
        assert!((bounds[0].left()-10.).abs()<0.001,"{bounds:?}");assert!((bounds[1].left()-20.).abs()<0.001,"{bounds:?}");
    }

    #[test]
    fn annotation_appearance_is_not_culled_by_one_pixel_registrar() {
        let mut doc=document(b"",Dictionary::new());
        let appearance=Stream::new(dictionary!{"BBox"=>vec![0.into(),0.into(),10.into(),10.into()]},b"1 0 0 0 k 0 0 10 10 re f".to_vec());
        let annotation=doc.add_object(dictionary!{"Type"=>"Annot","Subtype"=>"Stamp","Rect"=>vec![50.into(),60.into(),70.into(),80.into()],
            "AP"=>dictionary!{"N"=>Object::Stream(appearance)}});
        let page=doc.get_pages()[&1];doc.get_dictionary_mut(page).unwrap().set("Annots",vec![Object::Reference(annotation)]);
        let scene=RetainedPage::compile(&doc,1,RenderOptions::softproof().with_annotations(true),None).unwrap();
        assert_eq!(scene.commands.len(),1);
        let RetainedKind::Path{path,..}=&scene.commands[0].kind else{panic!()};
        assert_eq!(path.bounds().left(),50.);assert_eq!(path.bounds().top(),60.);assert_eq!(path.bounds().width(),20.);
    }

    #[test]
    fn resource_opacity_does_not_depend_on_current_fill_color() {
        let image=Stream::new(dictionary!{"Subtype"=>"Image","Width"=>1,"Height"=>1,"BitsPerComponent"=>8,"ColorSpace"=>"DeviceCMYK"},vec![255,0,0,0]);
        let form=Stream::new(dictionary!{"Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),10.into(),10.into()],
            "Group"=>dictionary!{"S"=>"Transparency","I"=>true}},b"1 0 0 0 k 0 0 10 10 re f".to_vec());
        let none=vec![Object::Name(b"Separation".to_vec()),Object::Name(b"None".to_vec()),Object::Name(b"DeviceCMYK".to_vec()),
            dictionary!{"FunctionType"=>2,"Domain"=>vec![0.into(),1.into()],"C0"=>vec![0.into();4],"C1"=>vec![1.into();4],"N"=>1}.into()];
        let doc=document(b"/N cs 1 sc /G gs /I Do /F Do",dictionary!{"ColorSpace"=>dictionary!{"N"=>none},
            "ExtGState"=>dictionary!{"G"=>dictionary!{"ca"=>0.25,"BM"=>"Multiply"}},
            "XObject"=>dictionary!{"I"=>Object::Stream(image),"F"=>Object::Stream(form)}});
        let scene=RetainedPage::compile(&doc,1,RenderOptions::viewer(),None).unwrap();
        assert_eq!(scene.commands.len(),2);
        for draw in &scene.commands {assert_eq!(draw.paint.alpha,0.25);assert_eq!(draw.paint.blend,BlendMode::Multiply);}
    }

    #[test]
    fn pattern_inherits_line_state_from_stream_start_not_invocation(){
        let cell=Stream::new(dictionary!{"PatternType"=>1,"PaintType"=>1,"TilingType"=>1,
            "BBox"=>vec![0.into(),0.into(),10.into(),10.into()],"XStep"=>100,"YStep"=>100,"Resources"=>Dictionary::new()},b"0 0 m 10 10 l S".to_vec());
        let doc=document(b"9 w /Pattern cs /P scn 0 0 50 50 re f",dictionary!{"Pattern"=>dictionary!{"P"=>Object::Stream(cell)}});
        let scene=RetainedPage::compile(&doc,1,RenderOptions::viewer(),None).unwrap();
        let RetainedKind::Group{commands,..}=&scene.commands[0].kind else{panic!()};
        let RetainedKind::Stroke{style,..}=&commands[0].kind else{panic!()};assert_eq!(style.width,1.);
    }

    #[test]
    fn pattern_stroke_clip_keeps_hairline_and_dash_after_wire() {
        let cell=Stream::new(dictionary!{"PatternType"=>1,"PaintType"=>1,"TilingType"=>1,
            "BBox"=>vec![0.into(),0.into(),10.into(),10.into()],"XStep"=>10,"YStep"=>10,"Resources"=>Dictionary::new()},b"1 0 0 0 k 0 0 10 10 re f".to_vec());
        let doc=document(b"/Pattern CS /P SCN 0 w [5 5] 0 d 0 10 m 100 10 l S",dictionary!{"Pattern"=>dictionary!{"P"=>Object::Stream(cell)}});
        let scene=RetainedPage::compile(&doc,1,RenderOptions::viewer(),None).unwrap();
        let mut wire=Vec::new();scene.write_wire(1,&mut wire).unwrap();let scene=RetainedPage::read_wire(&wire[..],1,1024*1024).unwrap();
        assert!(!scene.commands.is_empty());let mut clip=scene.commands[0].state.clip.as_ref();let mut found=false;
        while let Some(c)=clip {if let Some(stroke)=&c.stroke{
            found=true;assert_eq!(stroke.style.width,0.);assert_eq!(stroke.style.dash,vec![5.,5.]);
            for scale in [0.25,1.,8.] {let p=stroke.style.device_path(&stroke.path,stroke.matrix.then(&Matrix::scale(scale,scale))).unwrap();assert!((p.bounds().height()-1.).abs()<0.001);}
        }clip=c.parent.as_ref();}assert!(found);
    }

    #[test]
    fn uncolored_pattern_keeps_caller_ink_and_cell_positions(){
        let cell=Stream::new(dictionary!{"PatternType"=>1,"PaintType"=>2,"TilingType"=>1,
            "BBox"=>vec![0.into(),0.into(),5.into(),5.into()],"XStep"=>10,"YStep"=>10,"Resources"=>Dictionary::new()},b"0 g 0 0 5 5 re f".to_vec());
        let doc=document(b"/PCS cs 0 1 0 0 /P scn 0 0 30 20 re f",dictionary!{
            "ColorSpace"=>dictionary!{"PCS"=>vec![Object::Name(b"Pattern".to_vec()),Object::Name(b"DeviceCMYK".to_vec())]},
            "Pattern"=>dictionary!{"P"=>Object::Stream(cell)}});
        let scene=RetainedPage::compile(&doc,1,RenderOptions::viewer(),None).unwrap();
        let RetainedKind::Group{commands,isolated,..}=&scene.commands[0].kind else{panic!("thiếu group pattern")};
        assert!(!isolated);assert_eq!(commands.len(),6);
        for (i,draw) in commands.iter().enumerate(){
            assert_eq!(draw.paint.ink,vec![0.,1.,0.,0.]);
            let RetainedKind::Path{path,..}=&draw.kind else{panic!()};
            assert_eq!(path.bounds().left(),(i%3) as f32*10.);assert_eq!(path.bounds().top(),(i/3) as f32*10.);
        }
    }

    #[test]
    #[ignore = "đo file R01 cục bộ qua PRYNX_R01_PDF"]
    fn compile_r01_real_pdf() {
        let path=std::env::var("PRYNX_R01_PDF").unwrap();
        let now=std::time::Instant::now();
        let doc=Document::load(path).unwrap();
        let cm=ColorManager::from_cmyk_profile(std::path::Path::new("../backend/app/assets/icc/FOGRA39.icc"),crate::color::RenderIntent::RelativeColorimetric).unwrap();
        let scene=RetainedPage::compile(&doc,1,RenderOptions::softproof(),Some(&cm)).unwrap();
        println!("R01 retained: {} lệnh ngoài, {} kênh, {:?}, warnings={:?}",scene.commands.len(),scene.space.len(),now.elapsed(),scene.warnings);
        assert!(scene.commands.len()>100);
        assert_eq!(scene.warnings.dropped_objects,0);
    }
}
