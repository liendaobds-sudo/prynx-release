//! Định tuyến response theo wire ID; không giữ khóa khi đợi worker.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{mpsc, Mutex};

use super::{read_frame, RenderWorkerFrame, RenderWorkerFrameKind, RenderWorkerResponse};

pub(super) type ResponseResult = Result<RenderWorkerFrame<RenderWorkerResponse>, String>;

#[derive(Default)]
struct RouterState {
    pending: HashMap<u64, mpsc::Sender<ResponseResult>>,
    terminal_error: Option<String>,
}

/// PERF (audit 2026-09-23 §R23.02): một reader sở hữu stdout, mỗi request có
/// mailbox riêng. Reply đến đảo thứ tự không được ghép sang bitmap của job khác.
#[derive(Default)]
pub(super) struct ResponseRouter {
    state: Mutex<RouterState>,
}

impl ResponseRouter {
    pub(super) fn register(&self, request_id: u64) -> Result<mpsc::Receiver<ResponseResult>, String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(error) = &state.terminal_error { return Err(error.clone()); }
        if state.pending.contains_key(&request_id) {
            return Err("Wire request ID đang có waiter, không được ghi đè.".into());
        }
        let (sender, receiver) = mpsc::channel();
        state.pending.insert(request_id, sender);
        Ok(receiver)
    }

    fn deliver(&self, frame: RenderWorkerFrame<RenderWorkerResponse>) -> Result<(), String> {
        if frame.kind != RenderWorkerFrameKind::Response {
            let error = "Worker trả frame không phải response.".to_string();
            self.fail(error.clone());
            return Err(error);
        }
        let sender = self.state.lock().unwrap_or_else(|p| p.into_inner())
            .pending.remove(&frame.request_id);
        let Some(sender) = sender else {
            let error = format!("Worker trả wire ID không có waiter hoặc bị lặp: {}.", frame.request_id);
            self.fail(error.clone());
            return Err(error);
        };
        // Caller đã bỏ ticket vẫn phải tiêu thụ frame đúng ID. Không chuyển
        // response đó cho waiter khác, và không làm chết các request còn sống.
        let _ = sender.send(Ok(frame));
        Ok(())
    }

    pub(super) fn fail(&self, error: String) {
        let (error, pending) = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.terminal_error.is_none() { state.terminal_error = Some(error); }
            let error = state.terminal_error.as_ref().unwrap().clone();
            (error, std::mem::take(&mut state.pending))
        };
        // Lỗi đầu là terminal cho instance worker; đánh thức toàn bộ waiter.
        for (_, sender) in pending { let _ = sender.send(Err(error.clone())); }
    }

    pub(super) fn read_responses(&self, mut reader: impl Read) {
        loop {
            match read_frame::<_, RenderWorkerResponse>(&mut reader) {
                Ok(frame) => if self.deliver(frame).is_err() { return; },
                Err(error) => {
                    self.fail(format!("Không đọc được response worker: {error}"));
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(request_id: u64) -> RenderWorkerFrame<RenderWorkerResponse> {
        RenderWorkerFrame { kind: RenderWorkerFrameKind::Response, request_id,
            header: RenderWorkerResponse::Pong { nonce: request_id.to_string(), worker_pid: 1 },
            payload: vec![request_id as u8] }
    }

    #[test]
    fn response_dao_thu_tu_van_ve_dung_waiter() {
        let router = ResponseRouter::default();
        let first = router.register(1).unwrap();
        let second = router.register(2).unwrap();
        router.deliver(response(2)).unwrap();
        assert_eq!(second.recv().unwrap().unwrap().payload, vec![2]);
        assert!(first.try_recv().is_err());
        router.deliver(response(1)).unwrap();
        assert_eq!(first.recv().unwrap().unwrap().payload, vec![1]);
    }

    #[test]
    fn terminal_error_danh_thuc_tat_ca_va_khong_nhan_request_moi() {
        let router = ResponseRouter::default();
        let first = router.register(1).unwrap();
        let second = router.register(2).unwrap();
        router.fail("pipe mất".into());
        router.fail("lỗi sau không ghi đè".into());
        for receiver in [first, second] {
            assert_eq!(receiver.recv_timeout(std::time::Duration::from_secs(1)).unwrap().unwrap_err(), "pipe mất");
        }
        assert_eq!(router.register(3).unwrap_err(), "pipe mất");
        assert!(router.state.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn duplicate_register_khong_ghi_de_waiter() {
        let router = ResponseRouter::default();
        let first = router.register(1).unwrap();
        assert!(router.register(1).is_err());
        router.deliver(response(1)).unwrap();
        assert_eq!(first.recv().unwrap().unwrap().request_id, 1);
    }

    #[test]
    fn wrong_kind_unknown_va_duplicate_response_lam_loi_toan_router() {
        for case in 0..3 {
            let router = ResponseRouter::default();
            let first = router.register(1).unwrap();
            let second = router.register(2).unwrap();
            let mut invalid = response(1);
            match case {
                0 => invalid.kind = RenderWorkerFrameKind::Request,
                1 => invalid.request_id = 999,
                _ => { router.deliver(response(1)).unwrap(); assert!(first.recv().unwrap().is_ok()); }
            }
            assert!(router.deliver(invalid).is_err());
            assert!(second.recv_timeout(std::time::Duration::from_secs(1)).unwrap().is_err());
            assert!(router.register(3).is_err());
        }
    }

    #[test]
    fn receiver_bi_bo_khong_lam_lech_response_cua_job_khac() {
        let router = ResponseRouter::default();
        drop(router.register(1).unwrap());
        let second = router.register(2).unwrap();
        router.deliver(response(1)).unwrap();
        router.deliver(response(2)).unwrap();
        assert_eq!(second.recv().unwrap().unwrap().request_id, 2);
        assert!(router.register(3).is_ok());
    }

    #[test]
    fn reader_giu_frame_hop_le_va_bao_eof_cho_frame_bi_cat() {
        let router = ResponseRouter::default();
        let first = router.register(1).unwrap();
        let second = router.register(2).unwrap();
        let mut wire = Vec::new();
        let first_frame = response(1);
        super::super::write_frame(&mut wire, first_frame.kind, 1, &first_frame.header, &first_frame.payload).unwrap();
        wire.extend_from_slice(b"PXRW");
        router.read_responses(std::io::Cursor::new(wire));
        assert_eq!(first.recv().unwrap().unwrap().payload, vec![1]);
        assert!(second.recv_timeout(std::time::Duration::from_secs(1)).unwrap().is_err());
        assert!(router.register(3).is_err());
    }

    #[test]
    fn nhieu_thread_dang_ky_va_reader_dao_thu_tu_khong_mat_mailbox() {
        let router = std::sync::Arc::new(ResponseRouter::default());
        let registered = std::sync::Arc::new(std::sync::Barrier::new(17));
        let mut joins = Vec::new();
        for id in 1..=16 {
            let router = router.clone();
            let registered = registered.clone();
            joins.push(std::thread::spawn(move || {
                let receiver = router.register(id).unwrap();
                registered.wait();
                assert_eq!(receiver.recv_timeout(std::time::Duration::from_secs(2)).unwrap().unwrap().request_id, id);
            }));
        }
        registered.wait();
        for id in (1..=16).rev() { router.deliver(response(id)).unwrap(); }
        for join in joins { join.join().unwrap(); }
        assert!(router.state.lock().unwrap().pending.is_empty());
    }
}
