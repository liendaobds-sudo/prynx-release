/**
 * unrecordedCommit — cửa duy nhất cho các thao tác THAY WORKING FILE mà chưa có
 * hợp đồng ghi quy trình (chưa `noteOperation`/`noteNonRecordable`).
 *
 * RECIPE (audit 2026-08-16 §REC.4): `commitWorkingFile` fail-closed bằng cách NÉM
 * lỗi khi không có vé. Nhưng phần lớn tool gọi `onFileFixed(...)` mà KHÔNG await,
 * nên rejection rơi vào Promise không ai bắt: try/catch của tool không thấy gì và
 * vài tool vẫn bật cờ thành công ⇒ người dùng tin là đã đóng dấu/đã sửa metadata
 * trong khi file không đổi. Vì vậy quyết định phải lấy TRƯỚC khi commit, và phải
 * là một giá trị trả về (chặn có lý do), không phải một exception.
 *
 * File CỐ Ý thuần (chỉ đọc recorder store) để test được trọn vẹn.
 */
import { recipeRecorder, type RecipeOperationTicket } from './RecipeRecorder';

/**
 * Có phải chặn commit này lại vì tab đang ghi quy trình mà thao tác không mang vé?
 *
 * - Có vé → không chặn ở đây; `commitWorkingFile` tự kiểm vé còn hợp lệ hay không.
 * - Không ghi ở tab này → không chặn (tab khác vẫn làm việc độc lập).
 * - Đang ghi ở tab này mà không có vé → CHẶN: thao tác chưa thể trở thành một Step.
 */
export function shouldBlockUnrecordedCommit(
    tabId: string,
    ticket?: RecipeOperationTicket | null,
): boolean {
    if (ticket) return false;
    return recipeRecorder.isRecordingFor(tabId);
}
