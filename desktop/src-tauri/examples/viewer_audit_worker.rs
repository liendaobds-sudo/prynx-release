//! V27: executable kiểm thử worker độc lập, không mở Tauri/GUI.
fn main(){
    let code=if std::env::args().any(|a|a=="--audit-gpu"){
        match gpu_probe(){Ok(())=>0,Err(error)=>{eprintln!("Probe GPU: {error}");2}}
    }else if std::env::args().any(|a|a=="--prynx-scene-worker"){
        app_lib::viewport::scene_worker::run_stdio()
    }else if std::env::args().any(|a|a=="--prynx-render-worker"){
        app_lib::run_render_worker_stdio()
    }else{eprintln!("Chỉ dùng --prynx-scene-worker hoặc --prynx-render-worker cho probe headless.");2};
    app_lib::flush_render_perf_log();std::process::exit(code);
}

fn gpu_probe()->Result<(),String>{
    use std::{sync::{Arc,atomic::AtomicU64},time::Instant};
    use sha2::{Digest,Sha256};
    use viewer_gpu::{GpuContext,retained_renderer::RetainedRenderer};
    let args:Vec<_>=std::env::args().collect();let flag=args.iter().position(|a|a=="--audit-gpu").unwrap();
    let pdf=args.get(flag+1).ok_or("Thiếu PDF")?;let out=std::path::PathBuf::from(args.get(flag+2).ok_or("Thiếu thư mục output")?);
    if out.exists(){return Err("Không ghi đè output benchmark cũ".into());}std::fs::create_dir_all(&out).map_err(|e|e.to_string())?;
    let input_sha=format!("{:x}",Sha256::digest(std::fs::read(pdf).map_err(|e|e.to_string())?));
    let exe_sha=format!("{:x}",Sha256::digest(std::fs::read(std::env::current_exe().map_err(|e|e.to_string())?).map_err(|e|e.to_string())?));
    let at=Instant::now();let mut worker=app_lib::viewport::scene_worker::SceneWorker::spawn()?;
    let (scene,compile)=worker.compile(pdf,1,1,Arc::new(AtomicU64::new(1)))?;let scene_wall_ms=at.elapsed().as_secs_f64()*1000.;
    let scene=Arc::new(scene);let color=app_lib::viewport::scene_worker::color_manager()?;
    let at=Instant::now();let ctx=GpuContext::new_sync().map_err(|e|e.to_string())?;let gpu_init_ms=at.elapsed().as_secs_f64()*1000.;
    let uploads=Arc::new(std::sync::Mutex::new(Vec::new()));let sink=uploads.clone();
    ctx.set_timing_sink(Arc::new(move|stage,result|{let value=match result{Ok(s)=>serde_json::json!({"stage":stage,"gpu_span_us":s.gpu_span_us,"submit_to_callback_us":s.submit_to_callback_us}),Err(error)=>serde_json::json!({"stage":stage,"error":error})};if let Ok(mut rows)=sink.lock(){rows.push(value);}}));
    let renderer=RetainedRenderer::new(&ctx,scene.clone(),&color,wgpu::TextureFormat::Rgba8Unorm).map_err(|e|e.to_string())?;
    let (width,height)=(998,748);let mut samples=Vec::new();
    for index in 0..21 {
        let partial=index%2==1;
        let (scale,x,y)=if index==0{(96./72.,0.,0.)}else{(5.37,-912.25-index as f32*7.,-421.75-index as f32*3.)};
        let region=partial.then_some([width-130,0,130,height]);
        let target=ctx.create_target_texture(width,height,wgpu::TextureFormat::Rgba8Unorm,None);
        let (tx,rx)=std::sync::mpsc::channel();let at=Instant::now();
        let (stats,measured)=renderer.with_prepared_region_cancellable(&ctx,&target.create_view(&Default::default()),width,height,scene.page_to_view(scale,x,y),region,&||false,|p|{
            let measured=ctx.submit_measured(p.commands,move|sample|{let _=tx.send(sample);});(p.stats,measured)
        }).map_err(|e|e.to_string())?;
        ctx.device.poll(wgpu::Maintain::Wait);let completed_ms=at.elapsed().as_secs_f64()*1000.;
        let gpu=if measured{let value=rx.recv_timeout(std::time::Duration::from_secs(2)).map_err(|e|e.to_string())??;Some(serde_json::json!({"gpu_span_us":value.gpu_span_us,"submit_to_callback_us":value.submit_to_callback_us}))}else{None};
        if index==0 {std::fs::write(out.join("first-frame.rgba"),ctx.readback_texture_rgba8(&target,width,height).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;}
        samples.push(serde_json::json!({"index":index,"partial":partial,"region":region,"scale":scale,"pan":[x,y],"cpu_encode_us":stats.encode_us,"clip_us":stats.clip_us,"clip_cache_reused":stats.clip_cache_reused,"material_us":stats.material_prepare_us,"material_builds":stats.material_builds,"coverage_bytes":stats.coverage_bytes,"completed_ms":completed_ms,"gpu":gpu}));
    }
    let result=serde_json::json!({"schema":1,"headless":true,"displayed":"unobserved","profile":"desktop Cargo dev / print_engine+viewer_gpu opt-level=3","pdf":pdf,"page":1,"input_sha256":input_sha,"exe_sha256":exe_sha,"size":[width,height],"scene_wall_ms":scene_wall_ms,"compile":compile,"gpu_init_ms":gpu_init_ms,"gpu_query_enabled":ctx.gpu_timing_supported(),"prepare":{"lut_us":renderer.preparation.lut_us,"pipelines_us":renderer.preparation.pipelines_us,"validate_us":renderer.preparation.validate_us,"total_us":renderer.preparation.total_us},"samples":samples});
    let mut result=result;result["upload_timings"]=serde_json::json!(*uploads.lock().unwrap());
    result["upload_probe_enabled"]=serde_json::json!(ctx.upload_probe_enabled());
    std::fs::write(out.join("gpu-probe.json"),serde_json::to_vec_pretty(&result).unwrap()).map_err(|e|e.to_string())?;
    println!("{}",out.join("gpu-probe.json").display());Ok(())
}
