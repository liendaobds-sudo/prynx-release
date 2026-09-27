//! PERF (audit 2026-09-25 §R25.GPU.31): phiên parser riêng cho mỗi tài liệu.
//! Giữ cách ly process; protocol framed và revision không phụ thuộc vòng đời HWND.
use print_engine::{color::{icc::ColorManager,RenderIntent},content::RenderOptions,scene::retained::RetainedPage};
use serde::{Serialize,Deserialize};
use std::{io::{Read,Write,BufReader},process::{Child,ChildStdin,ChildStdout,Command,Stdio},sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}},time::{Duration,Instant}};
const PROFILE:&[u8]=include_bytes!("../../../../backend/app/assets/icc/FOGRA39.icc");
const HEADER_BYTES:u64=64*1024;
#[derive(Serialize,Deserialize)]
struct Request { path:String,page:usize,revision:u64,identity:String,#[serde(default)] phase_timings:bool }
#[derive(Default,Debug,Serialize,Deserialize)]
#[serde(default)]
pub struct CompileStats {
    pub parse_us:u128,pub compile_us:u128,pub transport_us:u128,pub worker_reused:bool,
    pub file_read_us:u128,pub color_init_us:u128,pub worker_spawn_us:u128,
    pub request_write_us:u128,pub reply_wait_us:u128,pub wire_read_decode_us:u128,
    pub serialize_us:u128,pub pipe_write_us:u128,pub wire_bytes:u64,pub phase_timings_supported:bool,
}
#[derive(Default,Serialize,Deserialize)]
struct WireTiming {serialize_us:u128,pipe_write_us:u128,wire_bytes:u64}
// PERF (audit 2026-09-27 §V27.05): tách thời gian ghi pipe khỏi CPU serialize;
// vẫn stream payload, không cấp thêm một bản sao hàng trăm MB chỉ để đo.
struct TimedWriter<'a,W:Write>{inner:&'a mut W,elapsed:Duration,bytes:u64}
impl<W:Write> Write for TimedWriter<'_,W>{
    fn write(&mut self,buf:&[u8])->std::io::Result<usize>{let at=Instant::now();let result=self.inner.write(buf);self.elapsed+=at.elapsed();if let Ok(n)=result{self.bytes+=n as u64;}result}
    fn flush(&mut self)->std::io::Result<()>{self.inner.flush()}
}
#[derive(Serialize,Deserialize)]
struct Reply {error:Option<String>,stats:CompileStats,#[serde(default)] phase_timings:bool}
pub fn color_manager()->Result<ColorManager,String>{ColorManager::from_cmyk_bytes(PROFILE,RenderIntent::RelativeColorimetric).map_err(|e|e.to_string())}
pub fn identity(path:&str)->Result<String,String>{Ok(crate::pdf_file_identity_token(crate::pdf_file_identity(path)?))}
fn options()->RenderOptions {
    RenderOptions::viewer()
        .with_memory_budget_bytes(crate::system_total_memory_bytes().map(|b|(b/2).min(usize::MAX as u64) as usize).unwrap_or(usize::MAX))
        .with_fallback_font(Arc::new(include_bytes!("../../../../backend/app/assets/fonts/DejaVuSans.ttf").to_vec()))
        .with_fallback_bold_font(Arc::new(include_bytes!("../../../../backend/app/assets/fonts/DejaVuSans-Bold.ttf").to_vec()))
}
fn write_header(value:&impl Serialize,w:&mut impl Write)->Result<(),String>{
    let bytes=serde_json::to_vec(value).map_err(|e|e.to_string())?;
    if bytes.len() as u64>HEADER_BYTES{return Err("Header scene quá dài".into());}
    w.write_all(&(bytes.len() as u32).to_le_bytes()).and_then(|_|w.write_all(&bytes)).map_err(|e|e.to_string())
}
fn read_header<T:serde::de::DeserializeOwned>(r:&mut impl Read)->Result<Option<T>,String>{
    let mut first=[0u8;1];if r.read(&mut first).map_err(|e|e.to_string())?==0{return Ok(None);}
    let mut len=[0u8;4];len[0]=first[0];r.read_exact(&mut len[1..]).map_err(|e|e.to_string())?;
    let len=u32::from_le_bytes(len) as u64;if len==0 || len>HEADER_BYTES{return Err("Header scene không hợp lệ".into());}
    let mut bytes=vec![0;len as usize];r.read_exact(&mut bytes).map_err(|e|e.to_string())?;
    serde_json::from_slice(&bytes).map(Some).map_err(|e|e.to_string())
}
fn compile_request(req:&Request,document:&mut Option<(String,String,lopdf::Document)>,cm:&ColorManager)->Result<(RetainedPage,CompileStats),String>{
    if req.page==0 || req.revision==0 || crate::is_sensitive_path(&req.path) || identity(&req.path)?!=req.identity{return Err("Tài liệu scene không hợp lệ hoặc đã thay đổi".into());}
    let started=Instant::now();let reused=document.as_ref().is_some_and(|(path,id,_)|path==&req.path && id==&req.identity);
    let mut file_read_us=0;
    if !reused {let bytes=std::fs::read(&req.path).map_err(|e|e.to_string())?;file_read_us=started.elapsed().as_micros();let doc=crate::load_lopdf_structure(&bytes,crate::system_total_memory_bytes())?;*document=Some((req.path.clone(),req.identity.clone(),doc));}
    let parse_us=started.elapsed().as_micros();let started=Instant::now();
    let scene=RetainedPage::compile(&document.as_ref().unwrap().2,req.page,options(),Some(cm)).map_err(|e|e.to_string())?;
    if identity(&req.path)?!=req.identity{*document=None;return Err("PDF đã thay đổi khi biên dịch scene".into());}
    Ok((scene,CompileStats{parse_us,compile_us:started.elapsed().as_micros(),file_read_us,worker_reused:reused,..Default::default()}))
}
pub fn run_stdio()->i32 {
    let result=(||->Result<(),String>{
        let color_at=Instant::now();let cm=color_manager()?;let mut color_init_us=color_at.elapsed().as_micros();let mut document=None;
        if !std::env::args().any(|a|a=="--prynx-scene-session") {
            // Giữ protocol một lượt cho công cụ benchmark/đối chiếu đã có.
            let req:Request=serde_json::from_reader(std::io::stdin().lock().take(HEADER_BYTES)).map_err(|e|e.to_string())?;
            return compile_request(&req,&mut document,&cm)?.0.write_wire(req.revision,std::io::stdout().lock());
        }
        let mut input=BufReader::new(std::io::stdin().lock());let mut output=std::io::stdout().lock();
        while let Some(req)=read_header::<Request>(&mut input)? {
            match compile_request(&req,&mut document,&cm) {
                Ok((scene,mut stats))=>{
                    stats.color_init_us=std::mem::take(&mut color_init_us);
                    write_header(&Reply{error:None,stats,phase_timings:req.phase_timings},&mut output)?;
                    let at=Instant::now();let mut sink=TimedWriter{inner:&mut output,elapsed:Duration::ZERO,bytes:0};
                    scene.write_wire(req.revision,&mut sink)?;
                    let timing=WireTiming{serialize_us:at.elapsed().saturating_sub(sink.elapsed).as_micros(),pipe_write_us:sink.elapsed.as_micros(),wire_bytes:sink.bytes};
                    if req.phase_timings{write_header(&timing,&mut output)?;}
                },
                Err(error)=>write_header(&Reply{error:Some(error),stats:Default::default(),phase_timings:false},&mut output)?,
            }
            output.flush().map_err(|e|e.to_string())?;
        }
        Ok(())
    })();
    match result{Ok(())=>0,Err(e)=>{eprintln!("PPE scene worker: {e}");2}}
}
pub struct SceneWorker {child:Arc<Mutex<Child>>,input:ChildStdin,output:BufReader<ChildStdout>,stderr:Option<std::thread::JoinHandle<()>>,broken:bool,spawn_us:u128}
impl SceneWorker {
    pub fn spawn()->Result<Self,String>{
        let spawn_at=Instant::now();
        #[cfg(test)]
        let exe=std::env::var_os("PRYNX_SCENE_TEST_EXE").map(std::path::PathBuf::from).unwrap_or(std::env::current_exe().map_err(|e|e.to_string())?);
        #[cfg(not(test))]
        let exe=std::env::current_exe().map_err(|e|e.to_string())?;
        let mut command=Command::new(exe);command.args(["--prynx-scene-worker","--prynx-scene-session"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=command.spawn().map_err(|e|e.to_string())?;
        if let Err(e)=crate::process_guard::adopt_child_process(child.id()){let _=child.kill();let _=child.wait();return Err(e);}
        let input=child.stdin.take().ok_or("Không có pipe request scene")?;let output=BufReader::new(child.stdout.take().ok_or("Không có pipe response scene")?);let mut errors=child.stderr.take().ok_or("Không có pipe lỗi scene")?;
        // Drain đến EOF, không giữ stderr vô hạn hoặc để worker nghẽn pipe.
        let stderr=std::thread::spawn(move||{let mut buf=[0u8;4096];while matches!(errors.read(&mut buf),Ok(n) if n>0){}});
        Ok(Self{child:Arc::new(Mutex::new(child)),input,output,stderr:Some(stderr),broken:false,spawn_us:spawn_at.elapsed().as_micros()})
    }
    pub fn is_alive(&self)->bool{!self.broken && self.child.lock().ok().is_some_and(|mut c|matches!(c.try_wait(),Ok(None)))}
    pub fn compile(&mut self,path:&str,page:usize,revision:u64,current:Arc<AtomicU64>)->Result<(RetainedPage,CompileStats),String>{
        if current.load(Ordering::Acquire)!=revision{return Err("Scene đã bị thay thế".into());}
        let request=Request{identity:identity(path)?,path:path.into(),page,revision,phase_timings:true};
        let child=self.child.clone();let cancellation=current.clone();let (done,stop)=std::sync::mpsc::channel();
        let watchdog=std::thread::spawn(move||{while matches!(stop.recv_timeout(Duration::from_millis(20)),Err(std::sync::mpsc::RecvTimeoutError::Timeout)){
            if cancellation.load(Ordering::Acquire)!=revision{if let Ok(mut c)=child.lock(){let _=c.kill();}break;}
        }});
        let began=Instant::now();let result=(||{
            write_header(&request,&mut self.input)?;self.input.flush().map_err(|e|e.to_string())?;
            let request_write_us=began.elapsed().as_micros();let header_at=Instant::now();
            let reply=read_header::<Reply>(&mut self.output)?.ok_or("Worker scene đã dừng")?;
            let reply_wait_us=header_at.elapsed().as_micros();
            if let Some(error)=reply.error{return Err(error);}
            let budget=crate::system_total_memory_bytes().map(|b|b/2).unwrap_or(usize::MAX as u64);
            let read_at=Instant::now();let scene=RetainedPage::read_wire(&mut self.output,revision,budget)?;
            let wire_read_decode_us=read_at.elapsed().as_micros();
            // ACK capability trước khi đọc trailer: worker cũ bỏ qua field mới
            // không được làm host chờ vô hạn một trailer không bao giờ đến.
            let supported=reply.phase_timings;
            let wire=if supported{read_header::<WireTiming>(&mut self.output)?.ok_or("Thiếu telemetry scene")?}else{WireTiming::default()};
            let mut stats=reply.stats;stats.transport_us=began.elapsed().as_micros().saturating_sub(stats.parse_us+stats.compile_us);
            stats.worker_spawn_us=std::mem::take(&mut self.spawn_us);stats.request_write_us=request_write_us;stats.reply_wait_us=reply_wait_us;stats.wire_read_decode_us=wire_read_decode_us;
            stats.serialize_us=wire.serialize_us;stats.pipe_write_us=wire.pipe_write_us;stats.wire_bytes=wire.wire_bytes;
            stats.phase_timings_supported=supported;
            if current.load(Ordering::Acquire)!=revision{return Err("Scene đã bị thay thế".into());}
            if identity(path)?!=request.identity{return Err("PDF đã thay đổi sau khi nhận scene".into());}
            Ok((scene,stats))
        })();
        let _=done.send(());let _=watchdog.join();
        if result.is_err(){self.broken=true;if let Ok(mut c)=self.child.lock(){let _=c.kill();}}
        result
    }
}
impl Drop for SceneWorker {fn drop(&mut self){if let Ok(mut c)=self.child.lock(){let _=c.kill();let _=c.wait();}if let Some(t)=self.stderr.take(){let _=t.join();}}}
// Tương thích các probe gọi compile một lượt; consumer mới đi qua scene_cache.
pub fn compile(path:String,page:usize,revision:u64,current:Arc<AtomicU64>)->Result<RetainedPage,String>{SceneWorker::spawn()?.compile(&path,page,revision,current).map(|(scene,_)|scene)}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framed_headers_preserve_boundaries_and_reject_truncation(){
        let req=Request{path:"a.pdf".into(),page:1,revision:4,identity:"rev".into(),phase_timings:true};let mut bytes=Vec::new();write_header(&req,&mut bytes).unwrap();let one=bytes.clone();write_header(&req,&mut bytes).unwrap();
        let mut input=&bytes[..];assert_eq!(read_header::<Request>(&mut input).unwrap().unwrap().revision,4);assert_eq!(read_header::<Request>(&mut input).unwrap().unwrap().page,1);assert!(read_header::<Request>(&mut input).unwrap().is_none());
        assert!(read_header::<Request>(&mut &one[..one.len()-1]).is_err());assert!(read_header::<Request>(&mut &(HEADER_BYTES as u32+1).to_le_bytes()[..]).is_err());
    }
    #[test]
    fn telemetry_wire_is_opt_in_and_counts_partial_writes(){
        let legacy:Request=serde_json::from_str(r#"{"path":"a","page":1,"revision":1,"identity":"x"}"#).unwrap();assert!(!legacy.phase_timings);
        let mut bytes=Vec::new();let mut sink=TimedWriter{inner:&mut bytes,elapsed:Duration::ZERO,bytes:0};sink.write_all(b"scene").unwrap();assert_eq!(sink.bytes,5);
        let legacy:CompileStats=serde_json::from_str(r#"{"parse_us":1,"compile_us":2,"transport_us":3,"worker_reused":true}"#).unwrap();assert_eq!(legacy.serialize_us,0);
        let reply:Reply=serde_json::from_str(r#"{"error":null,"stats":{"parse_us":1}}"#).unwrap();assert!(!reply.phase_timings);
    }
    #[test]
    #[ignore="worker thật: PRYNX_SCENE_TEST_EXE, PRYNX_R01_PDF"]
    fn cancellation_retires_worker_and_next_session_recovers(){
        let path=std::env::var("PRYNX_R01_PDF").unwrap();let current=Arc::new(AtomicU64::new(1));
        let mut worker=SceneWorker::spawn().unwrap();let changed=current.clone();
        let cancel=std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(10));changed.store(2,Ordering::Release);});
        assert!(worker.compile(&path,1,1,current.clone()).is_err());cancel.join().unwrap();
        assert!(!worker.is_alive());drop(worker);
        let mut worker=SceneWorker::spawn().unwrap();let (_,first)=worker.compile(&path,2,2,current.clone()).unwrap();
        let (_,second)=worker.compile(&path,2,2,current).unwrap();
        assert!(!first.worker_reused);assert!(second.worker_reused);
    }

}
