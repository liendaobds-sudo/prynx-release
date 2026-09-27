//! PERF (audit 2026-09-27 §V27.B3): timestamp GPU có chủ đích, không readback
//! framebuffer và không chặn luồng presenter. Span là đoạn queue, không scan-out.
use crate::GpuContext;

#[derive(Clone,Copy,Debug)]
pub struct QueueTiming {pub gpu_span_us:f64,pub submit_to_callback_us:f64}
pub type TimingSink=std::sync::Arc<dyn Fn(&str,Result<QueueTiming,String>)+Send+Sync>;
impl GpuContext {
    /// Đường probe có staging khác queue.write_texture; phải đo và báo riêng
    /// observer overhead, không tự bật chỉ vì đang thu timestamp frame.
    pub fn upload_probe_enabled(&self)->bool{
        self.gpu_timing_supported() && std::env::var("PRYNX_GPU_UPLOAD_PROBE").as_deref()==Ok("1")
    }
    pub fn set_timing_sink(&self,sink:TimingSink){if let Ok(mut slot)=self.timing_sink.lock(){*slot=Some(sink);}}
    pub fn submit_stage(&self,label:String,commands:impl IntoIterator<Item=wgpu::CommandBuffer>)->bool{
        let sink=self.timing_sink.lock().ok().and_then(|slot|slot.clone());
        self.submit_measured(commands,move|result|{if let Some(sink)=sink{sink(&label,result);}})
    }
    pub fn gpu_timing_supported(&self)->bool {
        self.device.features().contains(wgpu::Features::TIMESTAMP_QUERY|wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
    }
    /// Callback chỉ chạy sau resolve/map hoàn tất; caller cần poll(Poll) ở
    /// vòng nền. Không hỗ trợ/tắt đo thì submit thường, tuyệt đối không giả 0ms.
    pub fn submit_measured(&self,commands:impl IntoIterator<Item=wgpu::CommandBuffer>,done:impl FnOnce(Result<QueueTiming,String>)+Send+'static)->bool {
        if !self.gpu_timing_supported(){self.queue.submit(commands);return false;}
        let query=self.device.create_query_set(&wgpu::QuerySetDescriptor{label:Some("PPE queue timestamps"),ty:wgpu::QueryType::Timestamp,count:2});
        let resolved=self.device.create_buffer(&wgpu::BufferDescriptor{label:Some("PPE timestamp resolve"),size:16,usage:wgpu::BufferUsages::QUERY_RESOLVE|wgpu::BufferUsages::COPY_SRC,mapped_at_creation:false});
        let read=self.device.create_buffer(&wgpu::BufferDescriptor{label:Some("PPE timestamp readback (16 bytes)"),size:16,usage:wgpu::BufferUsages::MAP_READ|wgpu::BufferUsages::COPY_DST,mapped_at_creation:false});
        let mut before=self.device.create_command_encoder(&Default::default());before.write_timestamp(&query,0);
        let mut after=self.device.create_command_encoder(&Default::default());after.write_timestamp(&query,1);after.resolve_query_set(&query,0..2,&resolved,0);after.copy_buffer_to_buffer(&resolved,0,&read,0,16);
        let began=std::time::Instant::now();
        self.queue.submit(std::iter::once(before.finish()).chain(commands).chain(std::iter::once(after.finish())));
        let mapped=read.clone();let period=self.queue.get_timestamp_period() as f64;
        read.slice(..).map_async(wgpu::MapMode::Read,move|result|{
            if let Err(error)=result{done(Err(error.to_string()));return;}
            let bytes=mapped.slice(..).get_mapped_range();
            let begin=u64::from_le_bytes(bytes[0..8].try_into().unwrap());let end=u64::from_le_bytes(bytes[8..16].try_into().unwrap());
            drop(bytes);mapped.unmap();
            if end<begin || !period.is_finite() || period<=0. {done(Err("Timestamp GPU không hợp lệ".into()));return;}
            done(Ok(QueueTiming{gpu_span_us:(end-begin) as f64*period/1000.,submit_to_callback_us:began.elapsed().as_secs_f64()*1e6}));
        });true
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore="GPU thật; PRYNX_GPU_TIMING=1, không cần cửa sổ"]
    fn timestamp_resolves_without_framebuffer_readback(){
        let ctx=crate::GpuContext::new_sync().unwrap();assert!(ctx.gpu_timing_supported(),"Adapter phải hỗ trợ query khi chạy collector này");
        let buffer=ctx.device.create_buffer(&wgpu::BufferDescriptor{label:None,size:1024*1024,usage:wgpu::BufferUsages::COPY_DST,mapped_at_creation:false});
        let mut encoder=ctx.device.create_command_encoder(&Default::default());encoder.clear_buffer(&buffer,0,None);
        let (tx,rx)=std::sync::mpsc::channel();assert!(ctx.submit_measured([encoder.finish()],move|result|{let _=tx.send(result);}));
        ctx.device.poll(wgpu::Maintain::Wait);
        let sample=rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
        assert!(sample.gpu_span_us.is_finite() && sample.gpu_span_us>=0.);println!("GPU_QUERY {sample:?} readback_bytes=16 displayed=unobserved");
    }
}
