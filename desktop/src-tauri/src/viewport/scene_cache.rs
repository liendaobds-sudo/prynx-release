//! PERF (audit 2026-09-25 §R25.GPU.31): tài liệu/scene sống độc lập với HWND.
use super::{document_renderer::{CpuSource,DocumentRenderer,PreparedScene},scene_worker::{self,SceneWorker}};
use std::{collections::HashMap,sync::{Arc,LazyLock,Mutex,atomic::{AtomicU64,Ordering}},time::Instant};
use viewer_gpu::{GpuContext,retained_renderer::RendererResources};
type PageSlot=Arc<Mutex<Option<Arc<PreparedScene>>>>;
#[derive(Clone,Debug,Hash,Eq,PartialEq)]
struct PageKey {token:String,page:usize,gpu:u64,format:wgpu::TextureFormat}
struct DocumentEntry {
    identity:String,
    worker:Mutex<Option<SceneWorker>>,
    pages:Mutex<HashMap<PageKey,PageSlot>>,
}
static DOCUMENTS:LazyLock<Mutex<HashMap<String,Arc<DocumentEntry>>>>=LazyLock::new(||Mutex::new(HashMap::new()));
type ResourceSlot=Arc<Mutex<Option<Arc<RendererResources>>>>;
static RESOURCES:LazyLock<Mutex<HashMap<(u64,wgpu::TextureFormat),ResourceSlot>>>=LazyLock::new(||Mutex::new(HashMap::new()));
fn path_key(path:&str)->String{std::fs::canonicalize(path).unwrap_or_else(|_|path.into()).to_string_lossy().into_owned()}
fn pressure(total:u64,available:u64)->bool{
    let divisor=if total<8*1024*1024*1024{4}else if total<16*1024*1024*1024{6}else{10};
    available<total/divisor
}
fn gpu_memory_query(vendor:u32,device:u32)->Option<(u64,u64)>{
    use windows::{core::Interface,Win32::Graphics::Dxgi::{CreateDXGIFactory1,IDXGIFactory1,IDXGIAdapter3,DXGI_MEMORY_SEGMENT_GROUP_LOCAL,DXGI_QUERY_VIDEO_MEMORY_INFO}};
    // Ngân sách VRAM do Windows cấp động, không đặt trần trang cố định cho máy mạnh.
    let probe=||->Option<(u64,u64)>{unsafe{
        let factory:IDXGIFactory1=CreateDXGIFactory1().ok()?;let mut index=0;
        while let Ok(adapter)=factory.EnumAdapters1(index){
            index+=1;let desc=adapter.GetDesc1().ok()?;
            if desc.VendorId!=vendor || desc.DeviceId!=device{continue;}
            let adapter:IDXGIAdapter3=adapter.cast().ok()?;let mut info=DXGI_QUERY_VIDEO_MEMORY_INFO::default();
            adapter.QueryVideoMemoryInfo(0,DXGI_MEMORY_SEGMENT_GROUP_LOCAL,&mut info).ok()?;
            return Some((info.Budget,info.CurrentUsage));
        }
        None
    }};probe()
}
struct MemoryProbe {value:Option<(u64,u64)>,at:Instant,pending:bool,attempted:bool}
static MEMORY_PROBES:LazyLock<Mutex<HashMap<u64,MemoryProbe>>>=LazyLock::new(||Mutex::new(HashMap::new()));
// PERF (audit 2026-09-27 §V27.D1): truy vấn driver không thuộc critical path
// mở trang/present. Mỗi GPU chỉ có một probe pending; không giới hạn renderer.
pub(crate) fn gpu_memory_snapshot(ctx:&GpuContext)->Option<(u64,u64)>{
    let mut probes=MEMORY_PROBES.lock().ok()?;let id=ctx.identity();
    let probe=probes.entry(id).or_insert(MemoryProbe{value:None,at:Instant::now(),pending:false,attempted:false});
    let value=probe.value;
    if !probe.pending && (!probe.attempted || probe.at.elapsed()>=std::time::Duration::from_secs(1)) {
        probe.pending=true;probe.attempted=true;probe.at=Instant::now();let vendor=ctx.adapter_info.vendor;let device=ctx.adapter_info.device;
        if std::thread::Builder::new().name("ppe-gpu-memory-probe".into()).spawn(move||{
            let value=gpu_memory_query(vendor,device);
            if let Ok(mut probes)=MEMORY_PROBES.lock(){if let Some(probe)=probes.get_mut(&id){probe.value=value;probe.at=Instant::now();probe.pending=false;}}
        }).is_err(){probe.pending=false;}
    }
    value
}
fn resources(ctx:&GpuContext,format:wgpu::TextureFormat)->Result<Arc<RendererResources>,String>{
    let slot=RESOURCES.lock().map_err(|e|e.to_string())?.entry((ctx.identity(),format)).or_default().clone();
    let mut resource=slot.lock().map_err(|e|e.to_string())?;
    if let Some(value)=&*resource{return Ok(value.clone());}
    // Profile/intent native cố định hiện tại; thay hợp đồng phải tạo slot riêng.
    let value=Arc::new(RendererResources::new(ctx,&scene_worker::color_manager()?,format).map_err(|e|e.to_string())?);
    crate::perf_log(&format!("GPU_SHARED_PREPARE gpu={} lut_us={} pipelines_us={}",ctx.identity(),value.preparation.lut_us,value.preparation.pipelines_us));
    *resource=Some(value.clone());Ok(value)
}
fn document(path:&str,id:&str,pressured:bool)->Result<Arc<DocumentEntry>,String>{
    let key=path_key(path);let mut retired=Vec::new();
    let value={
        let mut docs=DOCUMENTS.lock().map_err(|e|e.to_string())?;
        if pressured{let keys:Vec<_>=docs.iter().filter(|(k,v)|*k!=&key && Arc::strong_count(v)==1).map(|(k,_)|k.clone()).collect();for k in keys{if let Some(v)=docs.remove(&k){retired.push(v);}}}
        if docs.get(&key).is_some_and(|v|v.identity!=id){if let Some(v)=docs.remove(&key){retired.push(v);}}
        docs.entry(key).or_insert_with(||Arc::new(DocumentEntry{identity:id.into(),worker:Mutex::new(None),pages:Mutex::new(HashMap::new())})).clone()
    };
    drop(retired);Ok(value)
}
pub fn close_document(path:&str){
    let old=DOCUMENTS.lock().ok().and_then(|mut docs|docs.remove(&path_key(path)));drop(old);
}
/// PERF (audit 2026-09-27 §V27.F): device lỗi chỉ thu tài nguyên của đúng
/// epoch GPU; giữ parser CPU và không lấy page-slot lock đang compile.
pub(crate) fn retire_gpu_resources(gpu:u64){
    let resources=RESOURCES.lock().ok().map(|mut slots|{
        let keys:Vec<_>=slots.keys().filter(|(id,_)|*id==gpu).copied().collect();
        keys.into_iter().filter_map(|key|slots.remove(&key)).collect::<Vec<_>>()
    });
    let docs:Vec<_>=DOCUMENTS.lock().map(|docs|docs.values().cloned().collect()).unwrap_or_default();
    let mut retired=Vec::new();for doc in docs{if let Ok(mut pages)=doc.pages.lock(){
        let keys:Vec<_>=pages.keys().filter(|key|key.gpu==gpu).cloned().collect();
        for key in keys{if let Some(page)=pages.remove(&key){retired.push(page);}}
    }}
    if let Ok(mut probes)=MEMORY_PROBES.lock(){probes.remove(&gpu);}
    drop(retired);drop(resources);
}
pub fn load(ctx:&GpuContext,format:wgpu::TextureFormat,path:String,page:usize,token:String,revision:u64,current:Arc<AtomicU64>)->Result<Arc<DocumentRenderer>,String>{
    let began=Instant::now();let id=scene_worker::identity(&path)?;
    let identity_us=began.elapsed().as_micros();let memory_at=Instant::now();
    let memory=crate::system_memory_status();
    let system_pressured=memory.is_some_and(|s|pressure(s.total_bytes,s.available_bytes));
    let gpu_memory=gpu_memory_snapshot(ctx);
    let memory_probe_us=memory_at.elapsed().as_micros();
    let gpu_is_pressured=gpu_memory.is_some_and(|(budget,current)| budget>0 && current>budget.saturating_mul(4)/5);
    let pressured=system_pressured || gpu_is_pressured;
    crate::perf_log(&format!(
        "GPU_MEMORY total_bytes={} available_bytes={} budget_bytes={} current_bytes={} system_pressure={} gpu_pressure={}",
        memory.map(|s|s.total_bytes).unwrap_or_default(),
        memory.map(|s|s.available_bytes).unwrap_or_default(),
        gpu_memory.map(|v|v.0).unwrap_or_default(),
        gpu_memory.map(|v|v.1).unwrap_or_default(),
        system_pressured,
        gpu_is_pressured
    ));
    let registry_at=Instant::now();let doc=document(&path,&id,pressured)?;
    let key=PageKey{token,page,gpu:ctx.identity(),format};
    let slot={let mut pages=doc.pages.lock().map_err(|e|e.to_string())?;
        // Chỉ thu cache khi RAM thực sự thiếu; view đang vẽ vẫn giữ Arc của nó.
        if pressured{pages.retain(|k,_|k==&key);}
        pages.entry(key).or_default().clone()
    };
    let registry_us=registry_at.elapsed().as_micros();let slot_at=Instant::now();
    let mut cached=slot.lock().map_err(|e|e.to_string())?;let page_lock_wait_us=slot_at.elapsed().as_micros();
    let mut worker_lock_wait_us=0;let mut resource_prepare_us=0;let mut scene_prepare_us=0;
    if current.load(Ordering::Acquire)!=revision{return Err("Scene đã bị thay thế".into());}
    let hit=cached.is_some();
    if cached.is_none(){
        let (scene,stats)={
            let lock_at=Instant::now();let mut worker=doc.worker.lock().map_err(|e|e.to_string())?;worker_lock_wait_us=lock_at.elapsed().as_micros();
            if !worker.as_ref().is_some_and(SceneWorker::is_alive){*worker=Some(SceneWorker::spawn()?);}
            worker.as_mut().unwrap().compile(&path,page,revision,current.clone())?
        };
        crate::perf_log(&format!("GPU_SCENE_COMPILE revision={revision} page={page} parse_us={} compile_us={} transport_us={} worker_reused={} scene_commands={} bounds=({:.2},{:.2},{:.2},{:.2}) warnings={:?}",
            stats.parse_us,stats.compile_us,stats.transport_us,stats.worker_reused,scene.commands.len(),scene.bounds.x0,scene.bounds.y0,scene.bounds.x1,scene.bounds.y1,scene.warnings));
        // PERF (audit 2026-09-27 §V27.05): phase con có chồng lấp giữa process;
        // không cộng write/read wall thành thời gian CPU hoặc IPC thuần.
        crate::perf_log(&format!("GPU_SCENE_WIRE revision={revision} page={page} file_read_us={} color_init_us={} worker_spawn_us={} request_write_us={} reply_wait_us={} serialize_us={} pipe_write_us={} wire_read_decode_us={} wire_bytes={}",stats.file_read_us,stats.color_init_us,stats.worker_spawn_us,stats.request_write_us,stats.reply_wait_us,stats.serialize_us,stats.pipe_write_us,stats.wire_read_decode_us,stats.wire_bytes));
        let scene=Arc::new(scene);let at=Instant::now();let gpu=resources(ctx,format)?;resource_prepare_us=at.elapsed().as_micros();
        let at=Instant::now();let value=Arc::new(PreparedScene::new(ctx,scene,gpu)?);scene_prepare_us=at.elapsed().as_micros();
        if current.load(Ordering::Acquire)!=revision || scene_worker::identity(&path)?!=id{return Err("Scene đã bị thay thế hoặc PDF đã thay đổi".into());}
        *cached=Some(value);
    }
    if scene_worker::identity(&path)?!=id{return Err("PDF đã thay đổi trước khi gắn scene".into());}
    let at=Instant::now();let renderer=Arc::new(DocumentRenderer::bind(cached.as_ref().unwrap(),format,CpuSource{path,page,revision,current})?);let bind_us=at.elapsed().as_micros();
    crate::perf_log(&format!("GPU_SCENE_PHASE revision={revision} page={page} identity_us={identity_us} memory_probe_us={memory_probe_us} registry_us={registry_us} page_lock_wait_us={page_lock_wait_us} worker_lock_wait_us={worker_lock_wait_us} resource_prepare_us={resource_prepare_us} scene_prepare_us={scene_prepare_us} bind_us={bind_us}"));
    crate::perf_log(&format!("GPU_SCENE_CACHE revision={revision} page={page} hit={hit} prepare_us={}",began.elapsed().as_micros()));
    Ok(renderer)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn retiring_gpu_epoch_keeps_other_device_and_document_worker(){
        let path=format!("v27-device-retire-{}",std::process::id());let doc=document(&path,"v1",false).unwrap();
        let old=PageKey{token:"v1".into(),page:1,gpu:u64::MAX-10,format:wgpu::TextureFormat::Rgba8Unorm};let new=PageKey{gpu:u64::MAX-9,..old.clone()};
        doc.pages.lock().unwrap().insert(old.clone(),Arc::new(Mutex::new(None)));doc.pages.lock().unwrap().insert(new.clone(),Arc::new(Mutex::new(None)));
        retire_gpu_resources(old.gpu);let pages=doc.pages.lock().unwrap();assert!(!pages.contains_key(&old));assert!(pages.contains_key(&new));drop(pages);
        assert!(Arc::ptr_eq(&doc,&document(&path,"v1",false).unwrap()));close_document(&path);
    }
    #[test]
    fn content_key_is_independent_of_view_revision_but_covers_token_page_device_and_format(){
        let key=PageKey{token:"a".into(),page:1,gpu:3,format:wgpu::TextureFormat::Bgra8Unorm};
        for changed in [PageKey{token:"b".into(),..key.clone()},PageKey{page:2,..key.clone()},PageKey{gpu:4,..key.clone()},PageKey{format:wgpu::TextureFormat::Bgra8UnormSrgb,..key.clone()}]{assert_ne!(key,changed);}
    }
    #[test]
    fn strong_machine_keeps_cache_without_pressure(){
        let gib=1024*1024*1024;assert!(!pressure(32*gib,16*gib));assert!(!pressure(16*gib,8*gib));
        assert!(pressure(32*gib,gib));assert!(pressure(4*gib,gib/2));
    }
    #[test]
    #[ignore="worker thật: PRYNX_SCENE_TEST_EXE, PRYNX_R01_PDF, PRYNX_STARTUP_OUT"]
    fn r01_session_reuses_scene_and_rebinds_revision(){
        let path=std::env::var("PRYNX_R01_PDF").unwrap();let out=std::path::PathBuf::from(std::env::var("PRYNX_STARTUP_OUT").unwrap());std::fs::create_dir_all(&out).unwrap();
        let _=crate::PERF_LOG_PATH.set(out.join("native.log"));
        let ctx=GpuContext::new_sync().unwrap();let current=Arc::new(AtomicU64::new(1));
        let mut csv=String::from("step,page,revision,load_us,first_frame_us\n");let mut scenes=Vec::new();
        for (step,page) in [1,2,1,1].into_iter().enumerate(){
            let rev=step as u64+1;current.store(rev,Ordering::Release);let began=Instant::now();
            let renderer=load(&ctx,wgpu::TextureFormat::Rgba8Unorm,path.clone(),page,"fixture-v1".into(),rev,current.clone()).unwrap();let load_us=began.elapsed().as_micros();
            let target=ctx.create_target_texture(1081,811,wgpu::TextureFormat::Rgba8Unorm,None);let began=Instant::now();
            renderer.with_prepared(&ctx,&target,1081,811,renderer.scene.page_to_view(104./72.,0.,0.),|p|{ctx.queue.submit(p.commands);}).unwrap();ctx.device.poll(wgpu::Maintain::Wait);
            csv.push_str(&format!("{step},{page},{rev},{load_us},{}\n",began.elapsed().as_micros()));
            std::fs::write(out.join(format!("step-{step}.rgba")),ctx.readback_texture_rgba8(&target,1081,811).unwrap()).unwrap();scenes.push(renderer.scene.clone());
        }
        assert!(Arc::ptr_eq(&scenes[0],&scenes[2]));assert!(Arc::ptr_eq(&scenes[0],&scenes[3]));assert!(!Arc::ptr_eq(&scenes[0],&scenes[1]));
        current.store(5,Ordering::Release);let changed=load(&ctx,wgpu::TextureFormat::Rgba8Unorm,path.clone(),1,"fixture-v2".into(),5,current.clone()).unwrap();assert!(!Arc::ptr_eq(&changed.scene,&scenes[0]));
        assert!(load(&ctx,wgpu::TextureFormat::Rgba8Unorm,path.clone(),1,"fixture-v1".into(),4,current).is_err());
        close_document(&path);assert!(!DOCUMENTS.lock().unwrap().contains_key(&path_key(&path)));
        std::fs::write(out.join("timing.csv"),&csv).unwrap();println!("{csv}");
    }
    #[test]
    fn changed_file_identity_retires_only_its_document_session(){
        let path=format!("scene-cache-identity-{}",std::process::id());let other=format!("{path}-other");
        let first=document(&path,"id-v1",false).unwrap();let neighbour=document(&other,"other-v1",false).unwrap();
        let repeated=document(&path,"id-v1",false).unwrap();assert!(Arc::ptr_eq(&first,&repeated));
        let changed=document(&path,"id-v2",false).unwrap();assert!(!Arc::ptr_eq(&first,&changed));
        assert!(Arc::ptr_eq(&neighbour,&document(&other,"other-v1",false).unwrap()));
        close_document(&path);close_document(&other);
    }

}
