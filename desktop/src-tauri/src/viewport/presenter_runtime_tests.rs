//! Kiểm bằng code với surface RIÊNG, luôn ẩn. Không ShowWindow, SetFocus,
//! SetCapture hay gửi mouse/key tới bất kỳ HWND nào của người dùng.
use super::*;
use super::super::win32_host::Win32ChildViewport;
use print_engine::{content::RenderOptions,scene::retained::RetainedPage};
use std::time::{Duration,Instant};
use viewer_gpu::retained_renderer::RetainedRenderer;
use windows::{core::w,Win32::UI::WindowsAndMessaging::{CreateWindowExW,DestroyWindow,GetForegroundWindow,IsWindowVisible,WS_OVERLAPPED}};

#[test]
#[ignore="Surface test luôn ẩn: PRYNX_PRESENTER_PDF, PRYNX_PRESENTER_OUT; PRYNX_PERF=1"]
fn production_presenter_stationary_and_continuous_camera_probe(){
    use sha2::{Digest,Sha256};
    let path=std::env::var("PRYNX_PRESENTER_PDF").unwrap();
    let out=std::path::PathBuf::from(std::env::var("PRYNX_PRESENTER_OUT").unwrap());
    assert!(!out.exists(),"Không ghi đè bằng chứng A/B");std::fs::create_dir_all(&out).unwrap();
    assert!(crate::perf_enabled(),"Bật telemetry chỉ cho process test");
    crate::PERF_LOG_PATH.set(out.join("presenter.log")).unwrap();
    let bytes=std::fs::read(&path).unwrap();let input_sha=format!("{:x}",Sha256::digest(&bytes));
    let exe_sha=format!("{:x}",Sha256::digest(std::fs::read(std::env::current_exe().unwrap()).unwrap()));
    let doc=lopdf::Document::load_mem(&bytes).unwrap();let cm=super::super::scene_worker::color_manager().unwrap();
    let scene=Arc::new(RetainedPage::compile(&doc,1,RenderOptions::viewer(),Some(&cm)).unwrap());
    let ctx=Arc::new(GpuContext::new_sync().unwrap());
    let (width,height)=(1292,733);
    unsafe {
        let foreground=GetForegroundWindow();
        let parent=CreateWindowExW(Default::default(),w!("STATIC"),w!("PPE test surface hidden"),WS_OVERLAPPED,0,0,width as i32,height as i32,None,None,None,None).unwrap();
        let view=Win32ChildViewport::create(parent,0,0,width,height,1.,ctx.clone()).unwrap();
        assert!(!IsWindowVisible(parent).as_bool() && !IsWindowVisible(view.hwnd).as_bool());
        let format=view.state.lock().unwrap().surface_config.format;
        let renderer=Arc::new(DocumentRenderer::gpu(Arc::new(RetainedRenderer::new(&ctx,scene.clone(),&cm,format).unwrap())));
        let (errors,received)=std::sync::mpsc::channel::<String>();
        {
            let mut state=view.state.lock().unwrap();state.begin_scene_revision(1).unwrap();state.install_renderer(1,renderer.clone()).unwrap();
            state.scene_event=Some(Arc::new(move|_,error,_,_|{if let Some(error)=error{let _=errors.send(error);}}));
        }
        let request=|camera:CameraSnapshot,sequence:u64|{
            let state=view.state.lock().unwrap();let at=Instant::now();
            state.presenter.as_ref().unwrap().request(FrameRequest{camera,renderer:Some(renderer.clone()),revision:1,at,
                notify:state.scene_event.clone(),input:Some(InputStamp{sequence,revision:1,at}),overlays:vec![]});
        };
        let read=||view.state.lock().unwrap().presenter.as_ref().unwrap().probe.lock().unwrap().clone();
        let wait=|camera:CameraSnapshot|{
            let start=Instant::now();loop{
                if let Ok(error)=received.try_recv(){panic!("Presenter thật báo lỗi: {error}");}
                let p=read();if p.camera==Some(camera) && p.settled{return p;}
                assert!(start.elapsed()<Duration::from_secs(20),"Presenter không kết thúc làm nét camera={camera:?}");
                std::thread::sleep(Duration::from_millis(2));
            }
        };
        let fit=(width as f32/scene.bounds.width()).min(height as f32/scene.bounds.height());
        let camera=CameraSnapshot{zoom:fit,pan_x:0.,pan_y:0.,dpr:1.,viewport_width:width,viewport_height:height};
        let started=Instant::now();request(camera,1);let stationary=wait(camera);ctx.device.poll(wgpu::Maintain::Wait);let stationary_ms=started.elapsed().as_secs_f64()*1000.;
        let mut last=camera;let started=Instant::now();let mut last_request=started;let mut input_lateness=Vec::new();
        // Không chờ từng camera nét: phát liên tục như wheel/pan thực tế.
        for i in 0..120u64 {
            let due=started+Duration::from_micros(i*16_667);
            if let Some(delay)=due.checked_duration_since(Instant::now()){std::thread::sleep(delay);}
            let phase=i as f32/119.;let factor=if i<35{1.15f32.powf(i as f32/3.)}else{5.37/fit};
            let zoom=fit*factor;
            last=CameraSnapshot{zoom,pan_x:-((scene.bounds.width()*zoom-width as f32)*0.5).max(0.)-phase*177.25,
                pan_y:-((scene.bounds.height()*zoom-height as f32)*0.5).max(0.)+phase*93.75,..camera};
            last_request=Instant::now();input_lateness.push(last_request.saturating_duration_since(due).as_micros());request(last,i+2);
        }
        let input_ms=last_request.duration_since(started).as_secs_f64()*1000.;
        let settled=wait(last);ctx.device.poll(wgpu::Maintain::Wait);let settle_ms=last_request.elapsed().as_secs_f64()*1000.;
        let replay_ms=started.elapsed().as_secs_f64()*1000.;
        std::thread::sleep(Duration::from_millis(150));let idle=read();
        assert_eq!(idle.presented_frames,settled.presented_frames,"Idle không được phát frame mới");
        assert_eq!(idle.refined_frames,settled.refined_frames,"Idle không được dựng tiếp");
        assert!(!IsWindowVisible(parent).as_bool() && !IsWindowVisible(view.hwnd).as_bool());
        // Lỗi validation thuộc context test, không mô phỏng reset GPU vật lý.
        // Khi idle cũng phải báo lỗi, không cần một input/present mới đánh thức.
        let invalid=ctx.device.create_buffer(&wgpu::BufferDescriptor{label:Some("PPE owned idle error probe"),size:16,usage:wgpu::BufferUsages::UNIFORM,mapped_at_creation:false});
        ctx.queue.write_buffer(&invalid,0,&[0;4]);
        let idle_error=received.recv_timeout(Duration::from_secs(2)).expect("Lỗi GPU khi idle phải được báo mà không cần input");
        let foreground_unchanged=GetForegroundWindow()==foreground;
        view.destroy().unwrap();DestroyWindow(parent).unwrap();crate::flush_render_perf_log();
        let snapshot=|p:&PresenterProbe|serde_json::json!({"presents":p.presented_frames,"refinements":p.refined_frames,"batches":p.submitted_batches,"peak_details":p.peak_details,
            "presenter_cpu_us":p.presenter_cpu_us,"credit_wait_us":p.credit_wait_us,"batch_sizes":p.batch_sizes,"batch_elapsed_us":p.batch_elapsed_us});
        let mode=std::env::var("PRYNX_PRESENTER_AB").unwrap_or_else(|_|"cooperative".into());
        let result=serde_json::json!({"ab_mode":mode,"exe_sha256":exe_sha,"pdf":path,"input_sha256":input_sha,"page":1,"production_presenter":true,"surface":"owned invisible HWND; no focus or input calls","displayed":"unobserved",
            "foreground_unchanged":foreground_unchanged,"stationary_ms":stationary_ms,"stationary":snapshot(&stationary),"replay_ms":replay_ms,"settle_after_input_ms":settle_ms,"final":snapshot(&settled),"idle":snapshot(&idle)});
        let mut result=result;result["input_duration_ms"]=input_ms.into();result["input_lateness_us"]=serde_json::json!(input_lateness);result["idle_error_reported"]=(!idle_error.is_empty()).into();
        std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        println!("mode={mode} stationary_ms={stationary_ms:.3} settle_ms={settle_ms:.3} presents={} refines={} cpu_ms={:.3}",settled.presented_frames,settled.refined_frames,settled.presenter_cpu_us as f64/1000.);
        assert!(stationary.presented_frames<=stationary.refined_frames+1,"Cùng camera: chỉ present khi nội dung đổi, không theo batch offscreen");
    }
}
