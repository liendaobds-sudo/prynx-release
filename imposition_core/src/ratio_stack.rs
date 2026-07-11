//! ratio_stack — phân bổ ô theo TỶ LỆ số lượng cho N-Up cắt xén (Phase 1: CÙNG cỡ).
//!
//! Nghiệp vụ: dao xén guillotine cắt cả chồng giấy, mọi tờ giống hệt nhau nên
//! "cùng một vị trí ô xuyên suốt cả chồng luôn là cùng một mẫu" → xén ra mỗi xấp
//! một loại sạch. Số ô mỗi mẫu trên 1 tờ phải theo TỶ LỆ số lượng (mẫu SL cao chiếm
//! nhiều ô hơn).
//!
//! Tầng này CHỈ lo TOÁN TỶ LỆ thuần (không hình học): nhận `(capacity, qtys)` →
//! trả số ô mỗi mẫu trên 1 tờ + số tờ. Việc GÁN ô-nào-cho-mẫu-nào theo kiểu rải
//! (sequential/cut_stacks) do caller làm vì cần cols/rows của layout.
//!
//! Phương pháp chia: largest-remainder (Hamilton) → tổng số ô = capacity chính xác,
//! kèm bảo đảm mỗi mẫu có SL>0 nhận TỐI THIỂU 1 ô (khi còn chỗ). Mẫu không đủ chỗ
//! (capacity < số mẫu) được trả trong `unplaced` để caller cảnh báo "tách bài in".

use serde::{Deserialize, Serialize};

/// Kết quả phân bổ tỷ lệ cho MỘT tờ.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatioStackAlloc {
    /// Số ô mỗi mẫu trên 1 tờ (index = chỉ số mẫu). Tổng = capacity (khi đủ chỗ).
    pub cells_per_page: Vec<usize>,
    /// Số tờ cần in — MỌI mẫu in cùng số tờ (xén cả chồng). = max_i ceil(qty_i / cells_i).
    pub n_sheets: usize,
    /// Chỉ số các mẫu có SL>0 nhưng KHÔNG được cấp ô nào (capacity < số mẫu dương).
    /// Caller dùng để cảnh báo người dùng nên tách sang bài in khác.
    pub unplaced: Vec<usize>,
}

/// Phân bổ `capacity` ô của 1 tờ cho các mẫu theo tỷ lệ `qtys`.
///
/// - `capacity`: số ô tối đa trên 1 tờ (từ layout lưới đều).
/// - `qtys`: số lượng cần in mỗi mẫu (âm/0 = không in mẫu đó).
pub fn solve_ratio_stack(capacity: usize, qtys: &[i64]) -> RatioStackAlloc {
    let n = qtys.len();
    let mut cells = vec![0usize; n];

    if capacity == 0 || n == 0 {
        return RatioStackAlloc { cells_per_page: cells, n_sheets: 1, unplaced: vec![] };
    }

    // Tổng SL dương.
    let total_q: i64 = qtys.iter().map(|&q| q.max(0)).sum();

    if total_q == 0 {
        // Không có SL nào → chia ĐỀU capacity cho mọi mẫu (largest-remainder trên tỷ lệ đều).
        let base = capacity / n;
        let rem = capacity % n;
        for i in 0..n {
            cells[i] = base + if i < rem { 1 } else { 0 };
        }
        return RatioStackAlloc { cells_per_page: cells, n_sheets: 1, unplaced: vec![] };
    }

    // ── Largest-remainder: floor(ideal) trước, phần dư chia theo remainder giảm dần ──
    let mut remainders: Vec<(f64, usize)> = Vec::with_capacity(n);
    let mut assigned = 0usize;
    for i in 0..n {
        let q = qtys[i].max(0);
        if q == 0 {
            continue;
        }
        let ideal = capacity as f64 * q as f64 / total_q as f64;
        let fl = ideal.floor() as usize;
        cells[i] = fl;
        assigned += fl;
        remainders.push((ideal - fl as f64, i));
    }

    // Phần dư leftover = capacity - tổng floor → cấp 1 ô cho các remainder lớn nhất.
    let mut leftover = capacity.saturating_sub(assigned);
    // Sắp remainder giảm dần; hoà thì mẫu SL lớn hơn ưu tiên (ổn định, dễ đoán).
    remainders.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| qtys[b.1].cmp(&qtys[a.1]))
    });
    let mut ri = 0usize;
    while leftover > 0 && !remainders.is_empty() {
        let (_, idx) = remainders[ri % remainders.len()];
        cells[idx] += 1;
        leftover -= 1;
        ri += 1;
    }

    // ── Bảo đảm mỗi mẫu SL>0 có TỐI THIỂU 1 ô: mượn từ mẫu đang có nhiều ô nhất ──
    // (chỉ mượn khi mẫu cho vẫn còn >1 ô sau khi mượn → không tạo mẫu 0 mới).
    loop {
        let need = (0..n).find(|&i| qtys[i] > 0 && cells[i] == 0);
        let Some(need_i) = need else { break };
        // Mẫu cho: nhiều ô nhất và > 1.
        let donor = (0..n)
            .filter(|&j| cells[j] > 1)
            .max_by_key(|&j| cells[j]);
        match donor {
            Some(d) => {
                cells[d] -= 1;
                cells[need_i] += 1;
            }
            None => break, // Không còn ai để mượn → capacity < số mẫu dương.
        }
    }

    // Mẫu SL>0 vẫn 0 ô → không đủ chỗ trên tờ (cần tách bài in khác).
    let unplaced: Vec<usize> = (0..n).filter(|&i| qtys[i] > 0 && cells[i] == 0).collect();

    // Số tờ: mọi mẫu in cùng số tờ = max ceil(qty_i / cells_i) trên các mẫu được cấp ô.
    let mut n_sheets = 1usize;
    for i in 0..n {
        if cells[i] > 0 && qtys[i] > 0 {
            let s = ((qtys[i] as usize) + cells[i] - 1) / cells[i]; // ceil
            if s > n_sheets {
                n_sheets = s;
            }
        }
    }

    RatioStackAlloc { cells_per_page: cells, n_sheets, unplaced }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ty_le_co_ban_720_30_480() {
        // capacity=32, SL 720/30/480 (tổng 1230). Ideal: 18.7 / 0.78 / 12.5.
        let r = solve_ratio_stack(32, &[720, 30, 480]);
        assert_eq!(r.cells_per_page.iter().sum::<usize>(), 32, "tổng ô = capacity");
        // Mẫu 30 (nhỏ nhất) vẫn phải có tối thiểu 1 ô.
        assert!(r.cells_per_page[1] >= 1, "mẫu SL nhỏ không được mất");
        // Thứ tự tỷ lệ: mẫu 720 nhiều ô nhất, 30 ít nhất.
        assert!(r.cells_per_page[0] > r.cells_per_page[2]);
        assert!(r.cells_per_page[2] > r.cells_per_page[1]);
        assert!(r.unplaced.is_empty());
    }

    #[test]
    fn so_to_theo_mau_thieu_nhat() {
        // capacity=10, SL 100/100. Chia đều 5/5 → mỗi mẫu ceil(100/5)=20 tờ.
        let r = solve_ratio_stack(10, &[100, 100]);
        assert_eq!(r.cells_per_page, vec![5, 5]);
        assert_eq!(r.n_sheets, 20);
    }

    #[test]
    fn khong_co_sl_chia_deu() {
        // total_q=0 → chia đều capacity.
        let r = solve_ratio_stack(8, &[0, 0, 0]);
        assert_eq!(r.cells_per_page.iter().sum::<usize>(), 8);
        assert_eq!(r.n_sheets, 1);
    }

    #[test]
    fn mau_sl_zero_khong_duoc_o() {
        // Mẫu giữa SL=0 → 0 ô; 2 mẫu còn lại chia hết capacity.
        let r = solve_ratio_stack(10, &[500, 0, 500]);
        assert_eq!(r.cells_per_page[1], 0, "mẫu SL=0 không nhận ô");
        assert_eq!(r.cells_per_page[0] + r.cells_per_page[2], 10);
        assert!(r.unplaced.is_empty(), "SL=0 không tính là unplaced");
    }

    #[test]
    fn capacity_nho_hon_so_mau_bao_unplaced() {
        // capacity=2 nhưng 3 mẫu đều có SL → 1 mẫu không đủ chỗ.
        let r = solve_ratio_stack(2, &[100, 100, 100]);
        assert_eq!(r.cells_per_page.iter().sum::<usize>(), 2);
        assert_eq!(r.unplaced.len(), 1, "1 mẫu bị đẩy ra (tách bài in)");
    }

    #[test]
    fn mot_mau_duy_nhat() {
        let r = solve_ratio_stack(32, &[1000]);
        assert_eq!(r.cells_per_page, vec![32]);
        assert_eq!(r.n_sheets, ((1000 + 31) / 32));
    }
}
