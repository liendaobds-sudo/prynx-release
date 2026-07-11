/**
 * Parse cột số lượng dán từ Excel (mỗi dòng 1 số) — CHẶT để không "nuốt" nhầm.
 *
 * Vì sao chặt: phiên bản cũ dùng parseInt() dễ dãi (đọc số ở đầu chuỗi rồi dừng)
 * nên các ca sau LỌT QUA guard và áp SAI số kèm báo "thành công" — nguy vì in tem
 * thật, tốn giấy/hỏng đơn:
 *   - Dán nhầm cột KÍCH THƯỚC ("5x10cm" → 5, "3.7x6.4cm" → 3).
 *   - Dán 2 cột (tab nối "720\t3.7..." → 7203).
 *   - Ngăn nghìn kiểu VN ("1.234" → 1 thay vì 1234).
 *   - Ô trống ở giữa → mọi số sau dồn lệch trang.
 *
 * Nay: bất kỳ dòng nào KHÔNG phải số nguyên sạch → trả lỗi CHỈ RÕ dòng nào, thay
 * vì đoán bừa. Dấu . và , được coi là ngăn nghìn (số lượng luôn là số nguyên).
 */

export type ParseQtysResult =
  | { ok: true; quantities: number[] }
  | { ok: false; error: string };

// Số nguyên thuần: "720", "0".
const PURE_DIGITS = /^\d+$/;
// Có ngăn nghìn: nhóm 1–3 số đầu rồi lặp (sep + đúng 3 số): "1.234", "12,345,678".
// Cố ý CHẶT: "1.5" / "12.34" (không đủ 3 số) → KHÔNG khớp → báo lỗi thay vì đoán 15.
const THOUSAND_GROUPED = /^\d{1,3}([.,]\d{3})+$/;

export function parsePastedQuantities(
  text: string,
  expectedCount?: number,
): ParseQtysResult {
  const lines = text.split(/\r?\n/);
  // Bỏ dòng trống Ở CUỐI (Excel hay thêm newline thừa khi copy) — KHÔNG coi là ô trống.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return { ok: false, error: "Chưa có dữ liệu — dán cột số lượng từ Excel vào ô trên." };
  }

  const quantities: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const cell = raw.trim();
    const lineNo = i + 1;

    // Ô trống Ở GIỮA → lệch trang; chỉ rõ dòng để người dùng biết sửa đâu.
    if (cell === "") {
      return {
        ok: false,
        error: `Dòng ${lineNo} bị trống — điền đủ số lượng rồi dán lại (ô trống làm lệch trang).`,
      };
    }
    // Có tab = đang dán NHIỀU CỘT (vd mã + số lượng, hoặc số lượng + kích thước).
    if (raw.includes("\t")) {
      return {
        ok: false,
        error: `Dòng ${lineNo} có nhiều cột — chỉ bôi CỘT SỐ LƯỢNG trong Excel rồi dán lại.`,
      };
    }
    // Bỏ khoảng trắng trong ô (một số locale ngăn nghìn bằng space: "1 234").
    const compact = cell.replace(/\s/g, "");
    if (!PURE_DIGITS.test(compact) && !THOUSAND_GROUPED.test(compact)) {
      return {
        ok: false,
        error: `Dòng ${lineNo} ("${cell}") không phải số nguyên hợp lệ — có thể bạn dán nhầm cột (vd kích thước "5x10cm").`,
      };
    }
    const n = parseInt(compact.replace(/[.,]/g, ""), 10);
    if (isNaN(n) || n < 0) {
      return { ok: false, error: `Dòng ${lineNo} ("${cell}") không đọc được thành số.` };
    }
    quantities.push(n);
  }

  // Guard cuối: số dòng phải khớp số trang/sản phẩm. Đặt SAU khi mọi dòng đã hợp
  // lệ để lỗi "dán nhầm cột" (báo rõ dòng) được ưu tiên hơn lỗi lệch tổng chung chung.
  if (expectedCount !== undefined && quantities.length !== expectedCount) {
    return {
      ok: false,
      error: `Dán ${quantities.length} dòng nhưng có ${expectedCount} trang — kiểm tra lại rồi dán lại.`,
    };
  }

  return { ok: true, quantities };
}
