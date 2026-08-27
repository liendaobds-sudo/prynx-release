/**
 * Chuỗi hiển thị và định dạng số cho phần tóm tắt kết quả — phase P11.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.4, §9.3.
 *
 * Tách khỏi `ResultSummary.tsx` vì eslint `react-refresh/only-export-components` không cho
 * một file component export hằng và hàm thuần. Cũng tiện: P13 chỉ cần đổi đúng file này khi
 * chuyển sang namespace i18n.
 *
 * Hai điều quan trọng ở đây không phải chuyện thẩm mỹ:
 *
 * 1. **`NO_FEASIBLE_POSE` và `SEARCH_BUDGET_EXHAUSTED` phải nói hai chuyện khác nhau.**
 *    §11.4 cấm dùng lẫn: một cái nghĩa là hình học thật không vừa (đổi khổ tờ hoặc nới
 *    ràng buộc xoay), cái kia nghĩa là chưa tìm đủ (tăng mức tìm kiếm). Gộp lại là đẩy thợ
 *    in đi sửa sai chỗ.
 * 2. **Định dạng số không được làm tròn dữ liệu.** `toPrecision(12)` chỉ cắt phần rác nhị
 *    phân của `double` (ví dụ `93.34000000000001`), vẫn giữ đủ chữ số có nghĩa của mm và độ.
 */

import type { CandidateRejectedReason, TerminationReason, UnplacedReason } from './types';

/** Ngưỡng báo lệch giữa tỷ lệ engine báo và tỷ lệ tính lại. 0,5% là sai số làm tròn hợp lý. */
export const UTILIZATION_MISMATCH_TOLERANCE = 0.005;

export const TERMINATION_TEXT: Record<TerminationReason, string> = {
  all_placed: 'Đã xếp hết và tìm xong theo kế hoạch',
  work_budget_exhausted: 'Hết ngân sách tìm kiếm — có thể còn phương án tốt hơn',
  deadline: 'Hết thời gian giới hạn — đây là phương án tốt nhất tìm được',
  max_sheets_reached: 'Chạm trần số tờ đã đặt',
  cancelled: 'Đã hủy giữa lúc tìm',
};

export const UNPLACED_TEXT: Record<UnplacedReason, string> = {
  NO_FEASIBLE_POSE:
    'Không vừa tờ ở mọi hướng được phép — cần đổi khổ tờ hoặc nới ràng buộc xoay',
  SEARCH_BUDGET_EXHAUSTED: 'Chưa tìm được chỗ trong ngân sách — thử mức tìm kiếm cao hơn',
  MAX_SHEETS_REACHED: 'Chạm trần số tờ — tăng số tờ tối đa',
  CANCELLED: 'Bị hủy trước khi xếp tới',
};

/** In số mm gọn nhưng KHÔNG mất chữ số có nghĩa. */
export function formatMm(value: number): string {
  return `${Number(value.toPrecision(12))} mm`;
}

export function formatPercent(ratio: number): string {
  return `${Number((ratio * 100).toPrecision(4))}%`;
}

export function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)} giây`;
}


/** Lý do một đường bế ứng viên bị loại khi nhập PDF (phase P13). */
export const CANDIDATE_REJECTED_TEXT: Record<CandidateRejectedReason, string> = {
  RING_NOT_CLOSED: 'Đường không kín — hai đầu cách nhau quá xa',
  RING_SELF_INTERSECTING: 'Đường tự cắt',
  RING_TOO_MANY_VERTICES: 'Quá nhiều điểm',
};
