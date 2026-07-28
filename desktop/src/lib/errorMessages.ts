import i18n from '../i18n';

/**
 * UIUX (audit 2026-07-27 §D-13/§D-15): dịch lỗi kỹ thuật thành câu tiếng Việt
 * kèm hướng khắc phục, và phân biệt LỖI HỆ THỐNG với LỖI THAO TÁC.
 *
 * Trước đây khi sidecar backend chưa lên hoặc bị tắt, người dùng nhận đúng chuỗi
 * `TypeError: Failed to fetch` — không hiểu gì, cũng không biết phải làm gì. Nhiều
 * chỗ khác lại ném thẳng body trả về của backend ra giao diện ("Backend merge
 * failed: <cả trang HTML>").
 *
 * UIUX (audit 2026-07-27 §D-13) fix-verify: heuristic phân loại đã siết lại —
 * canceled chỉ nhận DOMException/AbortError/"user cancelled" (không còn "aborted"
 * trần); 403/404/5xx chỉ khớp khi đi kèm ngữ cảnh mã lỗi (http/status/error…) hoặc
 * đứng đầu chuỗi, để số trần trong câu ("khổ giấy 550mm", "500 tờ") không bị nhận
 * nhầm. formatError không nuốt detail nữa: với lỗi đã phân loại (≠unknown/canceled)
 * mà chuỗi gốc khác câu dịch thì nối thêm dòng "Chi tiết: <raw>".
 *
 * Dùng:
 *   catch (e) { toast.error(formatError(e, 'Không xáo trộn được trang')); }
 *   catch (e) { setError(formatError(e)); }
 */

export type ErrorKind =
  | 'network'      // không gọi được backend (sidecar chưa lên / đã tắt / cổng bị chặn)
  | 'canceled'     // người dùng bấm Hủy hoặc component bị gỡ
  | 'permission'   // không có quyền ghi/đọc file, thiếu bản quyền
  | 'notfound'     // file/thư mục không còn
  | 'busy'         // máy đang bận / hết bộ nhớ
  | 'server'       // backend trả lỗi (4xx/5xx)
  | 'unknown';

export interface DescribedError {
  kind: ErrorKind;
  /** Câu chính, tiếng Việt, không chứa thuật ngữ kỹ thuật */
  message: string;
  /** Việc người dùng nên làm tiếp theo (nếu biết) */
  hint?: string;
  /** Chuỗi lỗi gốc đã rút gọn — để hiện nhỏ bên dưới hoặc ghi log */
  raw?: string;
}

const MAX_RAW = 200;

function rawTextOf(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    for (const key of ['detail', 'message', 'error']) {
      const v = anyErr[key];
      if (typeof v === 'string' && v) return v;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Backend đôi khi trả nguyên trang HTML lỗi hoặc traceback dài. Cắt gọn và bỏ thẻ
 * HTML để không đổ một khối chữ vô nghĩa vào toast.
 */
function tidyRaw(raw: string): string {
  let s = raw.trim();
  if (/<html|<!doctype/i.test(s)) {
    s = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Traceback Python: lấy dòng cuối (thường là dòng có ý nghĩa nhất)
  if (s.includes('Traceback (most recent call last)')) {
    const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
    s = lines[lines.length - 1] || s;
  }
  if (s.length > MAX_RAW) s = s.slice(0, MAX_RAW) + '…';
  return s;
}

export function describeError(err: unknown, context?: string): DescribedError {
  const raw = tidyRaw(rawTextOf(err));
  const lower = raw.toLowerCase();
  const name = err instanceof Error ? err.name : '';

  const withContext = (msg: string) => (context ? `${context}: ${msg}` : msg);

  // ── Người dùng chủ động hủy ────────────────────────────────────────────
  // UIUX (audit 2026-07-27 §D-13) fix-verify: bỏ 'aborted' trần — lỗi backend chứa
  // chữ "aborted" (vd. "transaction aborted") từng bị nuốt im lặng thành "Đã hủy".
  if (err instanceof DOMException || name === 'AbortError' || lower.includes('user cancelled')) {
    return {
      kind: 'canceled',
      message: i18n.t('shell:err_canceled', 'Đã hủy thao tác.'),
    };
  }

  // ── Không gọi được backend ─────────────────────────────────────────────
  if (
    name === 'TypeError' && lower.includes('fetch') ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('econnrefused') ||
    lower.includes('err_connection')
  ) {
    return {
      kind: 'network',
      message: withContext(
        i18n.t('shell:err_backend_down', 'không kết nối được với bộ xử lý của PrynX')
      ),
      hint: i18n.t(
        'shell:err_backend_down_hint',
        'Bộ xử lý nền có thể chưa khởi động xong hoặc đã bị tắt. Chờ vài giây rồi thử lại; nếu vẫn lỗi, đóng và mở lại PrynX.'
      ),
      raw,
    };
  }

  // ── Quyền / bản quyền ──────────────────────────────────────────────────
  // UIUX (audit 2026-07-27 §D-13) fix-verify: '403' trần khớp nhầm số trong câu
  // (vd. kích thước 403mm) → chỉ nhận khi có ngữ cảnh mã lỗi http/status.
  if (
    lower.includes('permission denied') ||
    lower.includes('access is denied') ||
    lower.includes('eacces') ||
    lower.includes('eperm') ||
    /\b(http|status)\s*[:=]?\s*403\b/.test(lower)
  ) {
    return {
      kind: 'permission',
      message: withContext(i18n.t('shell:err_permission', 'không có quyền truy cập file hoặc thư mục')),
      hint: i18n.t(
        'shell:err_permission_hint',
        'File có thể đang mở ở phần mềm khác, nằm trong thư mục chỉ-đọc, hoặc bị phần mềm diệt virus chặn. Đóng file ở phần mềm kia rồi thử lại, hoặc chọn thư mục lưu khác.'
      ),
      raw,
    };
  }

  // ── File không còn ─────────────────────────────────────────────────────
  // UIUX (audit 2026-07-27 §D-13) fix-verify: bỏ 'not found'/'404' trần ("font not
  // found", số 404 trong câu từng khớp nhầm) → siết thành 'file not found' và 404
  // có ngữ cảnh mã lỗi http/status.
  if (
    lower.includes('no such file') ||
    lower.includes('enoent') ||
    lower.includes('cannot find the file') ||
    /file not found/.test(lower) ||
    /\b(http|status)\s*[:=]?\s*404\b/.test(lower)
  ) {
    return {
      kind: 'notfound',
      message: withContext(i18n.t('shell:err_notfound', 'không tìm thấy file')),
      hint: i18n.t(
        'shell:err_notfound_hint',
        'File có thể đã bị di chuyển, đổi tên hoặc xóa. Mở lại file từ vị trí hiện tại của nó.'
      ),
      raw,
    };
  }

  // ── Hết bộ nhớ / máy quá tải ───────────────────────────────────────────
  if (
    lower.includes('out of memory') ||
    lower.includes('allocation failed') ||
    lower.includes('enomem') ||
    lower.includes('array buffer allocation')
  ) {
    return {
      kind: 'busy',
      message: withContext(i18n.t('shell:err_oom', 'máy không đủ bộ nhớ để xử lý file này')),
      hint: i18n.t(
        'shell:err_oom_hint',
        'Đóng bớt tab/phần mềm đang mở rồi thử lại. Với file rất nặng, hãy tách nhỏ file hoặc hạ độ phân giải xuất.'
      ),
      raw,
    };
  }

  // ── Backend trả lỗi có mã ──────────────────────────────────────────────
  // UIUX (audit 2026-07-27 §D-13) fix-verify: số 500-599 đứng trần trong câu (khổ
  // giấy 550mm, 500 tờ) từng bị coi là mã lỗi server → chỉ nhận khi có ngữ cảnh
  // (http/status/mã lỗi/error) hoặc mã đứng đầu chuỗi.
  if (/\b(http|status|mã lỗi|error)\s*[:=]?\s*5\d\d\b/i.test(raw) || /^5\d\d\b/.test(raw)) {
    return {
      kind: 'server',
      message: withContext(i18n.t('shell:err_server', 'bộ xử lý gặp lỗi khi chạy tác vụ này')),
      hint: i18n.t(
        'shell:err_server_hint',
        'Thử lại một lần nữa. Nếu vẫn lỗi, file nguồn có thể hỏng hoặc dùng tính năng PDF mà PrynX chưa hỗ trợ.'
      ),
      raw,
    };
  }

  return {
    kind: 'unknown',
    message: withContext(raw || i18n.t('shell:err_unknown', 'đã xảy ra lỗi không xác định')),
    raw: raw || undefined,
  };
}

/**
 * Bản gộp sẵn để đưa thẳng vào toast.error()/setError(): câu lỗi + xuống dòng +
 * hướng khắc phục. Toast đã bật `whitespace-pre-line` nên xuống dòng hiển thị đúng.
 */
export function formatError(err: unknown, context?: string): string {
  const d = describeError(err, context);
  // UIUX (audit 2026-07-27 §D-13) fix-verify: không vứt detail backend nữa — lỗi
  // đã phân loại (≠unknown/canceled) mà chuỗi gốc khác câu dịch thì nối thêm dòng
  // "Chi tiết: <raw>" để người dùng/hỗ trợ còn lần được nguyên nhân thật.
  const showRaw = d.kind !== 'unknown' && d.kind !== 'canceled' && d.raw && d.raw !== d.message;
  const rawLine = showRaw ? `${i18n.t('shell:err_raw_detail', 'Chi tiết')}: ${d.raw}` : undefined;
  return [d.message, d.hint, rawLine].filter(Boolean).join('\n');
}

/** true nếu lỗi là do người dùng bấm Hủy — thường thì KHÔNG cần báo gì thêm. */
export function isCanceled(err: unknown): boolean {
  return describeError(err).kind === 'canceled';
}
