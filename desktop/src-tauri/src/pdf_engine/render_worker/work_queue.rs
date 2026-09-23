//! Hàng đợi PPE song song với hàng rào thứ tự cho lệnh vòng đời/consumer cũ.

use std::collections::VecDeque;

struct Queued<T> { payload: T, priority: Option<(bool, i32)> }

pub(super) struct ReadyWork<T> { pub payload: T, pub concurrent: bool }

/// PERF (audit 2026-09-23 §R23.02): capacity do caller lấy từ ngân sách worker
/// hiện có, không đặt trần CPU/DPI mới. Không đưa job vượt qua lệnh close/release.
pub(super) struct WorkQueue<T> {
    pending: VecDeque<Queued<T>>,
    active: usize,
    capacity: usize,
}

impl<T> WorkQueue<T> {
    pub fn new(capacity: usize) -> Self {
        Self { pending: VecDeque::new(), active: 0, capacity: capacity.max(1) }
    }

    pub fn push(&mut self, payload: T, priority: Option<(bool, i32)>) {
        self.pending.push_back(Queued { payload, priority });
    }

    pub fn take_ready(&mut self) -> Option<ReadyWork<T>> {
        let first = self.pending.front()?;
        if first.priority.is_none() {
            return (self.active == 0).then(|| ReadyWork {
                payload: self.pending.pop_front().unwrap().payload, concurrent: false });
        }
        if self.active >= self.capacity { return None; }
        let index = self.pending.iter().take_while(|entry| entry.priority.is_some())
            .enumerate().min_by_key(|(index, entry)| (entry.priority.unwrap(), *index))?.0;
        self.active += 1;
        Some(ReadyWork { payload: self.pending.remove(index).unwrap().payload, concurrent: true })
    }

    pub fn finish(&mut self) {
        assert!(self.active > 0, "completion không có job đang chạy");
        self.active -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hai_job_chay_cung_luc_nhung_khong_vuot_capacity() {
        let mut queue = WorkQueue::new(2);
        for id in 0..3 { queue.push(id, Some((false, 10))); }
        assert_eq!(queue.take_ready().unwrap().payload, 0);
        assert_eq!(queue.take_ready().unwrap().payload, 1);
        assert!(queue.take_ready().is_none());
        queue.finish();
        assert_eq!(queue.take_ready().unwrap().payload, 2);
    }

    #[test]
    fn uu_tien_interactive_nhung_khong_vuot_close() {
        let mut queue = WorkQueue::new(4);
        queue.push("background", Some((true, 0)));
        queue.push("interactive", Some((false, 10)));
        queue.push("close", None);
        queue.push("revision-moi", Some((false, 0)));
        assert_eq!(queue.take_ready().unwrap().payload, "interactive");
        assert_eq!(queue.take_ready().unwrap().payload, "background");
        assert!(queue.take_ready().is_none());
        queue.finish();
        assert!(queue.take_ready().is_none());
        queue.finish();
        let close = queue.take_ready().unwrap();
        assert_eq!(close.payload, "close");
        assert!(!close.concurrent);
        assert_eq!(queue.take_ready().unwrap().payload, "revision-moi");
    }

    #[test]
    fn mot_slot_giu_duong_ram_thap_va_fifo_khi_cung_priority() {
        let mut queue = WorkQueue::new(1);
        queue.push(1, Some((true, 100))); queue.push(2, Some((true, 100)));
        assert_eq!(queue.take_ready().unwrap().payload, 1);
        assert!(queue.take_ready().is_none());
        queue.finish();
        assert_eq!(queue.take_ready().unwrap().payload, 2);
        queue.finish();
        assert!(queue.take_ready().is_none());
    }
}
