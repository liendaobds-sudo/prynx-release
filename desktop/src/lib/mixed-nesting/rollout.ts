/**
 * Cờ rollout của "Bình lồng ghép tự do" — phase P9.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §8.
 *
 * Module **nhẹ**, không import React và không kéo component. Lý do tách khỏi
 * `toolRegistry.ts`: registry kéo cả cây `lazy()` component, còn cờ này cần đọc được từ
 * test và từ những module không thuộc app shell — đúng cùng lý do
 * `preprocessRouterTools.ts` giữ `LOGO_REBUILD_ENABLED`.
 *
 * Ba quy tắc (§8):
 *
 * 1. **Mặc định HOLD.** Bản phát hành chỉ mở khi `VITE_MIXED_NESTING_ENABLED === 'true'`.
 * 2. **Cờ frontend và cờ backend phải bật cùng nhau.** `build_production.ps1` (P15a) nung
 *    cặp `VITE_MIXED_NESTING_ENABLED` + `PRYNX_MIXED_NESTING_ENABLED`; một bên bật lệch là
 *    trạng thái sai — UI hiện tool nhưng API trả 404, hoặc ngược lại.
 * 3. **Cờ KHÔNG thay license.** Cờ tắt thì tool biến khỏi registry; cờ bật mà gói Free thì
 *    vẫn bị chặn bởi `featureId`. Hai lớp độc lập.
 */

/** Tên cờ frontend. Trùng chính tả với `build_production.ps1`. */
export const MIXED_NESTING_FLAG_NAME = 'VITE_MIXED_NESTING_ENABLED' as const;

/** Tên cờ backend, để test parity chốt được cặp cờ. */
export const MIXED_NESTING_BACKEND_FLAG_NAME = 'PRYNX_MIXED_NESTING_ENABLED' as const;

/**
 * Quy tắc thuần, tách khỏi `import.meta.env` để test được cả bốn tổ hợp.
 *
 * Dev chạy Vite thông dịch luôn mở (giống mọi tính năng đang làm); bản phát hành phải bật
 * cờ tường minh.
 */
export function isMixedNestingEnabled(isDevelopment: boolean, releaseEnabled = false): boolean {
  return isDevelopment || releaseEnabled;
}

const RELEASE_ENABLED = import.meta.env.VITE_MIXED_NESTING_ENABLED === 'true';

/** Giá trị dùng thật trong registry. */
export const MIXED_NESTING_ENABLED = isMixedNestingEnabled(import.meta.env.DEV, RELEASE_ENABLED);
